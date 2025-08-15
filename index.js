// index.js
/**
 * Team management bot (discord.js v14)
 * Commands:
 *   /teamcreate [name]
 *   /teamadd <user>
 *   /teaminfo [leader_or_team_name?]
 *   /teamremove [user?]    <-- if no user: deletes team ONLY if leader AND team has 1 member
 *   /accept [team?]
 *   /decline [team?]
 *
 * Features:
 *  - Creates private text+voice channels under TEAM_CATEGORY_ID for each team
 *  - Updates channel permission overwrites when members join/leave
 *  - Decline cooldown (24h) and human readable cooldown messages
 *  - Pending invites removed when leader deletes team
 *
 * Env:
 *   DISCORD_TOKEN (required)
 *   CLIENT_ID (required)
 *   GUILD_ID (optional for registering guild commands)
 *   TEAM_CATEGORY_ID (optional — defaults to 1405551594824798229)
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionType,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits
} from "discord.js";
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "teams.json");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TEAM_CATEGORY_ID = process.env.TEAM_CATEGORY_ID || "1405551594824798229";

if (!TOKEN || !CLIENT_ID) {
  console.error("Please set DISCORD_TOKEN and CLIENT_ID environment variables.");
  process.exit(1);
}

// ---------- JSON storage ----------
async function loadData() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    const initial = { teams: {}, invites: [] };
    await fs.writeFile(DATA_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
}
async function saveData(data) {
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
}

// ---------- Helpers ----------
function nowISO() { return new Date().toISOString(); }
function plusDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
function msUntil(iso) {
  return Math.max(new Date(iso) - new Date(), 0);
}
function humanDurationMs(ms) {
  // returns "1d 3h 5m" or "3h 5m" etc
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}
function sanitizeChannelName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-_ ]/g, "").replace(/\s+/g, "-").slice(0, 90) || "team";
}

// find if a user is in any team
function findUserTeam(data, userId) {
  for (const team of Object.values(data.teams)) {
    if (team.members.includes(userId)) return team;
  }
  return null;
}

// Helper function to update message and disable buttons
async function disableInviteButtons(client, invite, statusText) {
  if (!invite.messageChannelId || !invite.messageId) return;

  try {
    const channel = await client.channels.fetch(invite.messageChannelId).catch(()=>null);
    if (!channel) return;
    const message = await channel.messages.fetch(invite.messageId).catch(()=>null);
    if (!message) return;

    // disabled buttons
    const acceptBtn = new ButtonBuilder()
      .setCustomId(`invite_accept::${invite.id}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true);

    const declineBtn = new ButtonBuilder()
      .setCustomId(`invite_decline::${invite.id}`)
      .setLabel("Decline")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true);

    const row = new ActionRowBuilder().addComponents(acceptBtn, declineBtn);

    // If original message had an embed, clone and update it; otherwise create a small one
    let newEmbed;
    if (message.embeds && message.embeds[0]) {
      const old = message.embeds[0];
      newEmbed = new EmbedBuilder(old.data || {})
        .setColor(statusText.toLowerCase().includes('accept') ? 0x00ff00 : statusText.toLowerCase().includes('decline') ? 0xff0000 : 0x808080)
        .setFooter({ text: statusText });
    } else {
      newEmbed = new EmbedBuilder()
        .setTitle("Invite")
        .setDescription(statusText)
        .setColor(0x808080)
        .setFooter({ text: statusText });
    }

    await message.edit({ embeds: [newEmbed], components: [row] }).catch(()=>null);
  } catch (err) {
    console.warn("Failed to disable buttons:", err);
  }
}

// Helper function to remove buttons completely (for expired invites)
async function removeInviteButtons(client, invite) {
  if (!invite.messageChannelId || !invite.messageId) return;

  try {
    const channel = await client.channels.fetch(invite.messageChannelId).catch(()=>null);
    if (!channel) return;
    const message = await channel.messages.fetch(invite.messageId).catch(()=>null);
    if (!message) return;

    let newEmbed;
    if (message.embeds && message.embeds[0]) {
      const old = message.embeds[0];
      newEmbed = new EmbedBuilder(old.data || {})
        .setColor(0x808080)
        .setFooter({ text: "This invite has expired (24 hours)" });
    } else {
      newEmbed = new EmbedBuilder()
        .setTitle("Invite expired")
        .setDescription("This invite has expired (24 hours)")
        .setColor(0x808080)
        .setFooter({ text: "This invite has expired (24 hours)" });
    }

    await message.edit({ embeds: [newEmbed], components: [] }).catch(()=>null);
  } catch (err) {
    console.warn("Failed to remove buttons:", err);
  }
}

// Clean up expired invites and update their messages
async function cleanupExpiredInvites(client, data) {
  const now = new Date();
  const expiredInvites = data.invites.filter(invite => {
    const inviteDate = new Date(invite.createdAt);
    const hoursDiff = (now - inviteDate) / (1000 * 60 * 60);
    return invite.status === "pending" && hoursDiff >= 24;
  });

  for (const invite of expiredInvites) {
    invite.status = "expired";
    await removeInviteButtons(client, invite);
  }

  if (expiredInvites.length > 0) {
    await saveData(data);
    console.log(`Cleaned up ${expiredInvites.length} expired invites`);
  }
}

// ---------- Commands ----------
const commands = [
  new SlashCommandBuilder()
    .setName("teamcreate")
    .setDescription("Create a team; you become the leader.")
    .addStringOption(opt => opt.setName("name").setDescription("Optional team name")),
  new SlashCommandBuilder()
    .setName("teamadd")
    .setDescription("Invite someone to your team (leader only).")
    .addUserOption(opt => opt.setName("user").setDescription("User to invite").setRequired(true)),
  new SlashCommandBuilder()
    .setName("teaminfo")
    .setDescription("Show info about a team (default: your team).")
    .addStringOption(opt => opt.setName("team").setDescription("Leader ID or team name")),
  new SlashCommandBuilder()
    .setName("teamremove")
    .setDescription("Remove a member or delete your team (leader only; delete only allowed if team has 1 member).")
    .addUserOption(opt => opt.setName("user").setDescription("Member to remove")),
  new SlashCommandBuilder()
    .setName("teamleave")
    .setDescription("Leave the team you're currently in."),
  new SlashCommandBuilder()
    .setName("teamnamechange")
    .setDescription("Change your team's name (leader only).")
    .addStringOption(opt => opt.setName("name").setDescription("New team name").setRequired(true)),
  new SlashCommandBuilder()
    .setName("accept")
    .setDescription("Accept a pending team invite.")
    .addStringOption(opt => opt.setName("team").setDescription("Leader ID or team name")),
  new SlashCommandBuilder()
    .setName("decline")
    .setDescription("Decline a pending team invite.")
    .addStringOption(opt => opt.setName("team").setDescription("Leader ID or team name")),
].map(c => c.toJSON());

// ---------- Register commands ----------
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      console.log("Registering guild commands to", GUILD_ID);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    } else {
      console.log("Registering global commands (may take up to 1 hour).");
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    }
    console.log("Commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Set up cleanup interval (every 30 minutes)
  setInterval(async () => {
    try {
      const data = await loadData();
      await cleanupExpiredInvites(client, data);
    } catch (err) {
      console.error("Error during cleanup:", err);
    }
  }, 30 * 60 * 1000); // 30 minutes
});

// Utility: create role + private channels and return ids
async function createTeamResources(guild, teamName, leaderId) {
  const baseName = sanitizeChannelName(teamName);
  // role name distinct
  const roleName = `team-${baseName}`;

  // Create role
  let role;
  try {
    role = await guild.roles.create({
      name: roleName,
      mentionable: false,
      hoist: false,
      reason: `Team role for ${teamName}`
    });
  } catch (err) {
    console.warn("Failed to create role, trying to continue:", err);
    // Try to find existing role with same name as fallback
    role = guild.roles.cache.find(r => r.name === roleName) || null;
  }

  // Permission overwrites:
  // - deny @everyone view
  // - allow the team role to view/connect
  // - allow the leader explicit permissions (in case you want leader separate)
  // - allow bot
  const everyoneId = guild.roles.everyone.id;
  const overwrites = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: role ? role.id : null, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
    { id: leaderId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect] }
  ].filter(x => x && x.id); // remove nulls if role missing

  // Create text channel
  let textChannel;
  try {
    textChannel = await guild.channels.create({
      name: `${baseName}-chat`,
      type: ChannelType.GuildText,
      parent: TEAM_CATEGORY_ID,
      permissionOverwrites: overwrites
    });
  } catch (err) {
    console.warn("create text channel failed, retrying without parent:", err);
    textChannel = await guild.channels.create({
      name: `${baseName}-chat`,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites
    }).catch(()=>null);
  }

  // Create voice channel
  let voiceChannel;
  try {
    voiceChannel = await guild.channels.create({
      name: `${baseName}-vc`,
      type: ChannelType.GuildVoice,
      parent: TEAM_CATEGORY_ID,
      permissionOverwrites: overwrites
    });
  } catch (err) {
    console.warn("create voice channel failed, retrying without parent:", err);
    voiceChannel = await guild.channels.create({
      name: `${baseName}-vc`,
      type: ChannelType.GuildVoice,
      permissionOverwrites: overwrites
    }).catch(()=>null);
  }

  return {
    roleId: role ? role.id : null,
    textChannelId: textChannel ? textChannel.id : null,
    voiceChannelId: voiceChannel ? voiceChannel.id : null
  };
}

// Grant access by adding the team role to the member
async function grantMemberChannelAccess(guild, team, memberId) {
  try {
    if (!team.roleId) {
      console.warn("grantMemberChannelAccess: no roleId for team", team.teamId);
      return;
    }
    const member = await guild.members.fetch(memberId).catch(()=>null);
    if (!member) return;
    // add role
    await member.roles.add(team.roleId, `Joining team ${team.name}`).catch(err => { console.warn("roles.add failed:", err); });
  } catch (err) {
    console.warn("grantMemberChannelAccess error:", err);
  }
}

// Revoke access by removing the team role from the member
async function revokeMemberChannelAccess(guild, team, memberId) {
  try {
    if (!team.roleId) return;
    const member = await guild.members.fetch(memberId).catch(()=>null);
    if (!member) return;
    await member.roles.remove(team.roleId, `Leaving team ${team.name}`).catch(() => null);
  } catch (err) {
    console.warn("revokeMemberChannelAccess error:", err);
  }
}

// Delete channels AND role
async function deleteTeamChannelsAndRole(guild, team) {
  try {
    if (team.textChannelId) {
      const ch = guild.channels.cache.get(team.textChannelId) || await guild.channels.fetch(team.textChannelId).catch(()=>null);
      if (ch) await ch.delete().catch(()=>null);
    }
    if (team.voiceChannelId) {
      const ch = guild.channels.cache.get(team.voiceChannelId) || await guild.channels.fetch(team.voiceChannelId).catch(()=>null);
      if (ch) await ch.delete().catch(()=>null);
    }
    if (team.roleId) {
      // try to delete role
      const role = guild.roles.cache.get(team.roleId) || await guild.roles.fetch(team.roleId).catch(()=>null);
      if (role) await role.delete(`Team ${team.name} deleted`).catch(err => console.warn("role delete failed:", err));
    }
  } catch (err) {
    console.warn("deleteTeamChannelsAndRole error:", err);
  }
}

// ---------- Interaction handling ----------
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.type === InteractionType.ApplicationCommand) {
      const data = await loadData();
      const userId = interaction.user.id;
      const guild = interaction.guild;

      // require guild for channel operations
      if (!guild) {
        // some commands can be used in DMs — keep behavior minimal
        if (["teamcreate", "teamadd", "teamremove"].includes(interaction.commandName)) {
          return interaction.reply({ content: "This command must be used inside a server (guild).", ephemeral: true });
        }
      }

      // ------------------ teamcreate ------------------
      if (interaction.commandName === "teamcreate") {
        const name = interaction.options.getString("name") || `${interaction.user.username}'s Team`;
        // check if user already in a team
        if (findUserTeam(data, userId)) {
          return interaction.reply({ content: "You are already in a team. Leave your current team before creating a new one.", ephemeral: true });
        }

        // check duplicate team name (case-insensitive)
        const nameTaken = Object.values(data.teams).some(t => t.name.toLowerCase() === name.toLowerCase());
        if (nameTaken) {
          return interaction.reply({ content: `A team named "${name}" already exists. Please choose a different name.`, ephemeral: true });
        }

        // create team data
        const teamId = userId;
        const team = {
          teamId,
          name,
          leaderId: userId,
          members: [userId],
          createdAt: nowISO(),
          guildId: guild?.id || null,
          textChannelId: null,
          voiceChannelId: null,
          roleId: null
        };

        // create resources if inside guild
        if (guild) {
          try {
            const resources = await createTeamResources(guild, name, userId);
            team.textChannelId = resources.textChannelId;
            team.voiceChannelId = resources.voiceChannelId;
            team.roleId = resources.roleId;
            // add leader role immediately so leader has access
            if (team.roleId) {
              const leaderMember = await guild.members.fetch(userId).catch(()=>null);
              if (leaderMember) await leaderMember.roles.add(team.roleId, "Team leader assigned role").catch(()=>null);
            }
          } catch (err) {
            console.warn("Failed to create team resources:", err);
          }
        }

        data.teams[teamId] = team;
        await saveData(data);

        // prepare embed
        const embed = new EmbedBuilder()
          .setTitle("Team created")
          .setDescription(`**${team.name}** — you are the leader.`)
          .addFields(
            { name: "Leader", value: `<@${team.leaderId}>`, inline: true },
            { name: "Members", value: `${team.members.length}/4`, inline: true }
          )
          .setTimestamp();

        if (team.textChannelId) embed.addFields({ name: "Text channel", value: `<#${team.textChannelId}>` });
        if (team.voiceChannelId) embed.addFields({ name: "Voice channel", value: `<#${team.voiceChannelId}>` });

        await interaction.reply({ embeds: [embed], ephemeral: false });
        return;
      }

      // ------------------ teamadd ------------------
      if (interaction.commandName === "teamadd") {
        const targetUser = interaction.options.getUser("user", true);
        const targetId = targetUser.id;

        const leaderTeam = data.teams[userId];
        if (!leaderTeam) return interaction.reply({ content: "You are not a team leader. Create a team first with /teamcreate.", ephemeral: true });
        if (leaderTeam.leaderId !== userId) return interaction.reply({ content: "Only the team leader may invite members.", ephemeral: true });
        if (targetId === userId) return interaction.reply({ content: "You cannot invite yourself.", ephemeral: true });

        // check target not already in team
        if (findUserTeam(data, targetId)) {
          return interaction.reply({ content: `<@${targetId}> is already in a team.`, ephemeral: true });
        }

        // check leaderTeam capacity
        if (leaderTeam.members.length >= 4) {
          return interaction.reply({ content: `Your team is full (4/4). Remove someone or delete the team first.`, ephemeral: true });
        }

        // check recent decline cooldown
        const recentDecline = data.invites.find(inv => inv.teamId === leaderTeam.teamId && inv.invitedId === targetId && inv.status === "declined" && inv.declinedUntil && new Date(inv.declinedUntil) > new Date());
        if (recentDecline) {
          const ms = msUntil(recentDecline.declinedUntil);
          return interaction.reply({ content: `<@${targetId}> recently declined an invite. You cannot invite them again for ${humanDurationMs(ms)} (until ${new Date(recentDecline.declinedUntil).toLocaleString()}).`, ephemeral: true });
        }

        // create invite
        const inviteId = `invite-${Date.now()}-${leaderTeam.teamId}-${targetId}`;
        const invite = {
          id: inviteId,
          teamId: leaderTeam.teamId,
          leaderId: leaderTeam.leaderId,
          invitedId: targetId,
          status: "pending",
          createdAt: nowISO(),
          declinedUntil: null
        };
        data.invites.push(invite);
        await saveData(data);

        const inviteEmbed = new EmbedBuilder()
          .setTitle("Team invite")
          .setDescription(`<@${targetId}>, you were invited to join **${leaderTeam.name}** by <@${leaderTeam.leaderId}>.`)
          .addFields(
            { name: "Team", value: leaderTeam.name, inline: true },
            { name: "Current members", value: `${leaderTeam.members.length}/4`, inline: true }
          )
          .setTimestamp();

        const acceptBtn = new ButtonBuilder().setCustomId(`invite_accept::${inviteId}`).setLabel("Accept").setStyle(ButtonStyle.Success);
        const declineBtn = new ButtonBuilder().setCustomId(`invite_decline::${inviteId}`).setLabel("Decline").setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(acceptBtn, declineBtn);

        // Send the invite message and fetch the message object so we can store its id
        const message = await interaction.reply({ content: `<@${targetId}>`, embeds: [inviteEmbed], components: [row], fetchReply: true });

        // Store message info for later button management
        invite.messageChannelId = interaction.channelId;
        invite.messageId = message.id;
        await saveData(data);

        // Schedule in-memory removal of buttons after exactly 24 hours (best-effort; cleanup task remains as fallback)
        setTimeout(async () => {
          try {
            const fresh = await loadData();
            const inv = fresh.invites.find(i => i.id === inviteId);
            if (inv && inv.status === "pending") {
              inv.status = "expired";
              await saveData(fresh);
              await removeInviteButtons(client, inv);
            }
          } catch (err) {
            console.warn("Scheduled expiry failed:", err);
          }
        }, 24 * 60 * 60 * 1000); // 24 hours

        return;
      }

      // ------------------ teaminfo ------------------
      if (interaction.commandName === "teaminfo") {
        const arg = interaction.options.getString("team");
        let team = null;
        if (!arg) {
          team = findUserTeam(data, userId);
          if (!team) return interaction.reply({ content: "You are not in a team and didn't specify a team. Use /teamcreate to make one or /teaminfo <leaderID|teamName> to view another.", ephemeral: true });
        } else {
          // try leader id
          if (data.teams[arg]) team = data.teams[arg];
          else team = Object.values(data.teams).find(t => t.name.toLowerCase() === arg.toLowerCase());
          if (!team) return interaction.reply({ content: `No team found for "${arg}".`, ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle(`Team: ${team.name}`)
          .addFields(
            { name: "Leader", value: `<@${team.leaderId}>`, inline: true },
            { name: "Members", value: `${team.members.length}/4`, inline: true },
            { name: "Member list", value: team.members.map((m, i) => `${i===0 ? "(leader) " : ""}<@${m}>`).join("\n") || "No members" }
          )
          .setTimestamp();

        if (team.textChannelId) embed.addFields({ name: "Text channel", value: `<#${team.textChannelId}>` });
        if (team.voiceChannelId) embed.addFields({ name: "Voice channel", value: `<#${team.voiceChannelId}>` });

        return interaction.reply({ embeds: [embed] });
      }

      // ------------------ teamremove ------------------
      if (interaction.commandName === "teamremove") {
        const targetUser = interaction.options.getUser("user");
        const leaderTeam = data.teams[userId];
        if (!leaderTeam) return interaction.reply({ content: "You are not a team leader.", ephemeral: true });
        if (leaderTeam.leaderId !== userId) return interaction.reply({ content: "Only the team leader may remove members or delete the team.", ephemeral: true });

        // If no user: attempt to delete team but only if members.length === 1
        if (!targetUser) {
          if (leaderTeam.members.length > 1) {
            return interaction.reply({ content: `Your team has ${leaderTeam.members.length} members. To delete the team it must have only 1 member (the leader). Remove other members first.`, ephemeral: true });
          }

          // proceed with deletion: remove invites, delete channels, delete team
          // remove invites related to this team
          const teamInvites = data.invites.filter(inv => inv.teamId === leaderTeam.teamId);
          for (const invite of teamInvites) {
            if (invite.status === "pending") {
              invite.status = "cancelled";
              await disableInviteButtons(client, invite, "Team was deleted");
            }
          }
          data.invites = data.invites.filter(inv => inv.teamId !== leaderTeam.teamId);
          await saveData(data);

          // delete channels if possible
          if (interaction.guild) {
            await deleteTeamChannelsAndRole(interaction.guild, leaderTeam);
          }

          delete data.teams[leaderTeam.teamId];
          await saveData(data);

          const embed = new EmbedBuilder()
            .setTitle("Team deleted")
            .setDescription(`Your team **${leaderTeam.name}** was deleted.`)
            .setTimestamp();

          return interaction.reply({ embeds: [embed] });
        }

        // removing a specific member
        const targetId = targetUser.id;
        if (targetId === userId) {
          return interaction.reply({ content: "To delete the team, use /teamremove with no user (only possible if your team has 1 member). You cannot remove yourself with this command.", ephemeral: true });
        }
        if (!leaderTeam.members.includes(targetId)) {
          return interaction.reply({ content: `<@${targetId}> is not in your team.`, ephemeral: true });
        }

        // remove member from team array and revoke channel perms
        leaderTeam.members = leaderTeam.members.filter(m => m !== targetId);
        await saveData(data);

        if (interaction.guild) await revokeMemberChannelAccess(interaction.guild, leaderTeam, targetId);

        const embed = new EmbedBuilder()
          .setTitle("Member removed")
          .setDescription(`<@${targetId}> has been removed from **${leaderTeam.name}**.`)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // ------------------ teamleave ------------------
      if (interaction.commandName === "teamleave") {
        const data = await loadData();
        const userId = interaction.user.id;
        const guild = interaction.guild;

        const team = findUserTeam(data, userId);
        if (!team) {
          return interaction.reply({ content: "You are not in a team.", ephemeral: true });
        }

        if (team.leaderId === userId) {
          return interaction.reply({
            content: "You are the team leader and cannot leave the team. To delete the team use /teamremove with no user (only possible if your team has 1 member). To keep the team but change leadership, transfer leadership (not implemented).",
            ephemeral: true
          });
        }

        // remove member from team
        team.members = team.members.filter(m => m !== userId);
        await saveData(data);

        // revoke channel access if in a guild
        if (guild) {
          await revokeMemberChannelAccess(guild, team, userId);
        }

        // notify leader
        const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
        if (leaderUser) {
          leaderUser.send(`<@${userId}> left your team **${team.name}**.`).catch(()=>null);
        }

        const embed = new EmbedBuilder()
          .setTitle("Left team")
          .setDescription(`You left **${team.name}**.`)
          .addFields({ name: "Members", value: `${team.members.length}/4` })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // ------------------ teamnamechange ------------------
      if (interaction.commandName === "teamnamechange") {
        const newName = interaction.options.getString("name", true).trim();
        if (!newName) return interaction.reply({ content: "Please provide a new team name.", ephemeral: true });

        const leaderTeam = data.teams[userId];
        if (!leaderTeam) return interaction.reply({ content: "You are not a team leader.", ephemeral: true });
        if (leaderTeam.leaderId !== userId) return interaction.reply({ content: "Only the team leader may change the team name.", ephemeral: true });

        // check duplicate name (case-insensitive) among other teams
        const taken = Object.values(data.teams).some(t => t.teamId !== leaderTeam.teamId && t.name.toLowerCase() === newName.toLowerCase());
        if (taken) {
          return interaction.reply({ content: `A team named "${newName}" already exists. Please pick a different name.`, ephemeral: true });
        }

        const oldName = leaderTeam.name;
        leaderTeam.name = newName;

        // Attempt to rename role and channels if in a guild
        if (interaction.guild) {
          const guildObj = interaction.guild;
          const base = sanitizeChannelName(newName);

          // rename role
          if (leaderTeam.roleId) {
            try {
              const role = guildObj.roles.cache.get(leaderTeam.roleId) || await guildObj.roles.fetch(leaderTeam.roleId).catch(()=>null);
              if (role) {
                await role.setName(`team-${base}`).catch(err => { console.warn("Failed to rename role:", err); });
              }
            } catch (err) {
              console.warn("Role rename error:", err);
            }
          }

          // rename text channel
          if (leaderTeam.textChannelId) {
            try {
              const tch = guildObj.channels.cache.get(leaderTeam.textChannelId) || await guildObj.channels.fetch(leaderTeam.textChannelId).catch(()=>null);
              if (tch) await tch.setName(`${base}-chat`).catch(err => { console.warn("Failed to rename text channel:", err); });
            } catch (err) {
              console.warn("Text channel rename error:", err);
            }
          }

          // rename voice channel
          if (leaderTeam.voiceChannelId) {
            try {
              const vch = guildObj.channels.cache.get(leaderTeam.voiceChannelId) || await guildObj.channels.fetch(leaderTeam.voiceChannelId).catch(()=>null);
              if (vch) await vch.setName(`${base}-vc`).catch(err => { console.warn("Failed to rename voice channel:", err); });
            } catch (err) {
              console.warn("Voice channel rename error:", err);
            }
          }
        }

        await saveData(data);

        const embed = new EmbedBuilder()
          .setTitle("Team renamed")
          .setDescription(`**${oldName}** → **${leaderTeam.name}**`)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // ------------------ accept / decline (slash) ------------------
      if (interaction.commandName === "accept" || interaction.commandName === "decline") {
        const isAccept = interaction.commandName === "accept";
        const arg = interaction.options.getString("team");

        // find matching pending invite(s)
        let invite = null;
        if (arg) {
          invite = data.invites
            .filter(inv => inv.invitedId === userId && inv.status === "pending" && (inv.leaderId === arg || (data.teams[inv.teamId] && data.teams[inv.teamId].name.toLowerCase() === arg.toLowerCase())))
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        } else {
          invite = data.invites
            .filter(inv => inv.invitedId === userId && inv.status === "pending")
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        }

        if (!invite) return interaction.reply({ content: "No pending invite found for you (or it may have expired).", ephemeral: true });

        const team = data.teams[invite.teamId];
        if (!team) {
          invite.status = "declined";
          await saveData(data);
          return interaction.reply({ content: "The team no longer exists.", ephemeral: true });
        }

        if (isAccept) {
          if (team.members.length >= 4) {
            invite.status = "declined";
            invite.declinedUntil = plusDaysISO(1);
            await saveData(data);
            await disableInviteButtons(client, invite, "Team was full when trying to accept");
            // notify leader
            if (interaction.guild) {
              const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
              if (leaderUser) leaderUser.send(`<@${userId}> tried to accept your invite to **${team.name}**, but the team was full.`);
            }
            return interaction.reply({ content: `Cannot join: team **${team.name}** is full. Leader was notified.`, ephemeral: true });
          }

          // add them
          team.members.push(userId);
          invite.status = "accepted";
          await saveData(data);
          await disableInviteButtons(client, invite, "Invite accepted");

          // grant channel access
          if (interaction.guild) await grantMemberChannelAccess(interaction.guild, team, userId);

          // respond
          const embed = new EmbedBuilder()
            .setTitle("Joined team")
            .setDescription(`You joined **${team.name}**!`)
            .addFields({ name: "Members", value: `${team.members.length}/4` })
            .setTimestamp();

          // notify leader privately
          const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
          if (leaderUser) leaderUser.send(`<@${userId}> accepted your invite to **${team.name}**.`).catch(()=>null);

          return interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
          // decline
          invite.status = "declined";
          invite.declinedUntil = plusDaysISO(1);
          await saveData(data);

          // notify leader
          const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
          if (leaderUser) leaderUser.send(`<@${userId}> declined your invite to **${team.name}**. You cannot invite them again for 24 hours.`).catch(()=>null);

          const embed = new EmbedBuilder()
            .setTitle("Invite declined")
            .setDescription(`You declined the invite to **${team.name}**.`)
            .addFields({ name: "Cooldown", value: `You cannot be invited again to this team for 24 hours.` })
            .setTimestamp();

          return interaction.reply({ embeds: [embed], ephemeral: true });
        }
      }

    } // end ApplicationCommand
  } catch (err) {
    console.error("Interaction handler error:", err);
    if (interaction && !interaction.replied) {
      try { await interaction.reply({ content: "An internal error occurred.", ephemeral: true }); } catch {}
    }
  }
});

// ----------------- Button interaction handler -----------------
client.on("interactionCreate", async (interaction) => {
  // handle button interactions separately
  if (!interaction.isButton()) return;

  const [action, inviteId] = interaction.customId.split("::");
  if (!inviteId) return interaction.reply({ content: "Invalid button payload.", ephemeral: true });

  const data = await loadData();
  const invite = data.invites.find(i => i.id === inviteId);
  if (!invite) return interaction.reply({ content: "Invite not found or already handled.", ephemeral: true });

  // Only invited user may press the buttons
  if (interaction.user.id !== invite.invitedId) {
    return interaction.reply({ content: "Only the invited user may accept or decline this invite.", ephemeral: true });
  }

  const team = data.teams[invite.teamId];
  if (!team) {
    invite.status = "declined";
    await saveData(data);
    await disableInviteButtons(interaction.client, invite, "Team no longer exists");
    return interaction.reply({ content: "The team no longer exists.", ephemeral: true });
  }

  if (action === "invite_accept") {
    if (findUserTeam(data, interaction.user.id)) {
      invite.status = "declined";
      await saveData(data);
      await disableInviteButtons(interaction.client, invite, "User already in another team");
      return interaction.reply({ content: "You are already in a team. Leave your current team before joining another.", ephemeral: true });
    }

    if (team.members.length >= 4) {
      invite.status = "declined";
      invite.declinedUntil = plusDaysISO(1);
      await saveData(data);
      await disableInviteButtons(interaction.client, invite, "Team was full");
      // notify leader
      const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
      if (leaderUser) leaderUser.send(`<@${interaction.user.id}> tried to accept your invite to **${team.name}**, but the team was full.`).catch(()=>null);

      return interaction.reply({ content: `Cannot join: team **${team.name}** is full.`, ephemeral: true });
    }

    team.members.push(interaction.user.id);
    invite.status = "accepted";
    await saveData(data);
    await disableInviteButtons(interaction.client, invite, "Invite accepted ✅");

    // grant channel access
    if (interaction.guild) await grantMemberChannelAccess(interaction.guild, team, interaction.user.id);

    // notify leader
    const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
    if (leaderUser) leaderUser.send(`<@${interaction.user.id}> accepted your invite to **${team.name}**.`).catch(()=>null);

    return interaction.reply({ content: `You joined **${team.name}**!`, ephemeral: true });
  }

  if (action === "invite_decline") {
    invite.status = "declined";
    invite.declinedUntil = plusDaysISO(1);
    await saveData(data);
    await disableInviteButtons(interaction.client, invite, "Invite declined ❌");

    // notify leader
    const leaderUser = await client.users.fetch(team.leaderId).catch(()=>null);
    if (leaderUser) leaderUser.send(`<@${interaction.user.id}> declined your invite to **${team.name}**. You cannot invite them again for 24 hours.`).catch(()=>null);

    const ms = msUntil(invite.declinedUntil);
    return interaction.reply({ content: `You declined the invite to **${team.name}**. You cannot be invited by this team again for ${humanDurationMs(ms)}.`, ephemeral: true });
  }

  return interaction.reply({ content: "Unknown button action.", ephemeral: true });
});

// register commands and login
(async () => {
  await registerCommands();
  client.login(TOKEN);
})();
