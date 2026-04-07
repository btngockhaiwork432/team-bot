require('dotenv').config();

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const TEAM_PREFIX = 'Team ';
const TEAM_TOPIC_PREFIX = 'TEAM_META';

// ===== Web server for Render =====
app.get('/', (req, res) => {
  res.status(200).send('Bot is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    botReady: client.isReady(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Health server listening on port ${PORT}`);
});

// ===== Helpers =====
function makeSafeChannelName(teamName) {
  return `team-${teamName}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

function normalizeHexColor(input) {
  if (!input) return null;
  const value = input.trim();

  if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
    return value.toUpperCase();
  }

  if (/^[0-9A-Fa-f]{6}$/.test(value)) {
    return `#${value.toUpperCase()}`;
  }

  return null;
}

function buildTeamTopic({ ownerId, roleId, teamName }) {
  return `${TEAM_TOPIC_PREFIX}|ownerId=${ownerId}|roleId=${roleId}|teamName=${encodeURIComponent(teamName)}`;
}

function parseTeamTopic(topic) {
  if (!topic || !topic.startsWith(`${TEAM_TOPIC_PREFIX}|`)) return null;

  const parts = topic.split('|').slice(1);
  const data = {};

  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    data[key] = rest.join('=');
  }

  return {
    ownerId: data.ownerId || null,
    roleId: data.roleId || null,
    teamName: data.teamName ? decodeURIComponent(data.teamName) : null,
  };
}

function findMemberTeamRole(member) {
  return member.roles.cache.find(role => role.name.startsWith(TEAM_PREFIX)) || null;
}

function findTeamChannelByRole(guild, roleId) {
  return guild.channels.cache.find(channel => {
    if (channel.type !== ChannelType.GuildText) return false;
    const meta = parseTeamTopic(channel.topic);
    return meta && meta.roleId === roleId;
  }) || null;
}

function findTeamChannelByOwner(guild, ownerId) {
  return guild.channels.cache.find(channel => {
    if (channel.type !== ChannelType.GuildText) return false;
    const meta = parseTeamTopic(channel.topic);
    return meta && meta.ownerId === ownerId;
  }) || null;
}

function getTeamDataByMember(guild, member) {
  const teamRole = findMemberTeamRole(member);
  if (!teamRole) return null;

  const teamChannel = findTeamChannelByRole(guild, teamRole.id);
  const meta = teamChannel ? parseTeamTopic(teamChannel.topic) : null;

  return {
    teamRole,
    teamChannel,
    meta,
  };
}

function getTeamDataByOwner(guild, ownerId) {
  const teamChannel = findTeamChannelByOwner(guild, ownerId);
  const meta = teamChannel ? parseTeamTopic(teamChannel.topic) : null;
  const teamRole = meta?.roleId ? guild.roles.cache.get(meta.roleId) || null : null;

  return {
    teamRole,
    teamChannel,
    meta,
  };
}

function resolveTeamData(guild, member, userId) {
  const byMember = getTeamDataByMember(guild, member);
  if (byMember?.meta?.ownerId === userId) return byMember;

  const byOwner = getTeamDataByOwner(guild, userId);
  if (byOwner?.meta?.ownerId === userId) return byOwner;

  return byMember || byOwner || null;
}

function resolveTeamForDelete(guild, member, ownerId) {
  const byMember = getTeamDataByMember(guild, member);
  if (byMember?.meta?.ownerId === ownerId) return byMember;

  const byOwner = getTeamDataByOwner(guild, ownerId);
  if (byOwner?.meta?.ownerId === ownerId) return byOwner;

  if (byMember?.teamRole && !byMember?.teamChannel) {
    return {
      ...byMember,
      meta: {
        ownerId,
        roleId: byMember.teamRole.id,
        teamName: byMember.teamRole.name.replace(TEAM_PREFIX, ''),
      },
    };
  }

  return byOwner?.teamRole || byOwner?.teamChannel ? byOwner : byMember;
}

function getBotMember(guild) {
  return guild.members.me || guild.members.cache.get(client.user.id) || null;
}

function getDeletePrecheck(guild, teamData) {
  const botMember = getBotMember(guild);
  if (!botMember) {
    return 'Bot không lấy được thông tin của chính nó trong server.\nBot could not resolve itself as a guild member.';
  }

  if (teamData.teamChannel && !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return 'Bot đang thiếu quyền Manage Channels.\nBot is missing Manage Channels permission.';
  }

  if (teamData.teamRole && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Bot đang thiếu quyền Manage Roles.\nBot is missing Manage Roles permission.';
  }

  if (teamData.teamRole) {
    const botHighest = botMember.roles.highest;
    if (!botHighest || botHighest.position <= teamData.teamRole.position) {
      return 'Role cao nhất của bot đang thấp hơn hoặc bằng role team nên Discord không cho bot xoá role.\nThe bot highest role must be above the team role.';
    }
  }

  return null;
}

async function fetchGuildMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function updateTeamChannelOwner(teamChannel, newOwnerId, roleId, teamName) {
  const newTopic = buildTeamTopic({
    ownerId: newOwnerId,
    roleId,
    teamName,
  });

  await teamChannel.setTopic(newTopic, `Transfer ownership to ${newOwnerId}`);
}

// ===== Commands with EN + VI localization =====
const commands = [
  new SlashCommandBuilder()
    .setName('createteam')
    .setNameLocalizations({ vi: 'taoteam' })
    .setDescription('Create a private team with a role and text channel')
    .setDescriptionLocalizations({ vi: 'Tạo team riêng với role và kênh chat riêng' })
    .addStringOption(option =>
      option
        .setName('name')
        .setNameLocalizations({ vi: 'ten' })
        .setDescription('Team name')
        .setDescriptionLocalizations({ vi: 'Tên team' })
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('color')
        .setNameLocalizations({ vi: 'mau' })
        .setDescription('HEX color, for example: #FF6600 or FF6600')
        .setDescriptionLocalizations({ vi: 'Mã màu HEX, ví dụ: #FF6600 hoặc FF6600' })
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('invite')
    .setNameLocalizations({ vi: 'moi' })
    .setDescription('Invite a user into your team')
    .setDescriptionLocalizations({ vi: 'Mời một người vào team của bạn' })
    .addUserOption(option =>
      option
        .setName('user')
        .setNameLocalizations({ vi: 'nguoidung' })
        .setDescription('User to invite')
        .setDescriptionLocalizations({ vi: 'Người muốn mời' })
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('kick')
    .setNameLocalizations({ vi: 'duoi' })
    .setDescription('Remove a user from your team')
    .setDescriptionLocalizations({ vi: 'Loại một người khỏi team của bạn' })
    .addUserOption(option =>
      option
        .setName('user')
        .setNameLocalizations({ vi: 'nguoidung' })
        .setDescription('User to remove')
        .setDescriptionLocalizations({ vi: 'Người muốn loại' })
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('leave')
    .setNameLocalizations({ vi: 'roiteam' })
    .setDescription('Leave your current team')
    .setDescriptionLocalizations({ vi: 'Rời khỏi team hiện tại của bạn' }),

  new SlashCommandBuilder()
    .setName('delete-team')
    .setNameLocalizations({ vi: 'xoateam' })
    .setDescription('Delete your team (owner only)')
    .setDescriptionLocalizations({ vi: 'Xoá team của bạn (chỉ owner dùng được)' }),

  new SlashCommandBuilder()
    .setName('transfer-owner')
    .setNameLocalizations({ vi: 'chuyenchu' })
    .setDescription('Transfer team ownership to another member')
    .setDescriptionLocalizations({ vi: 'Chuyển quyền owner team cho thành viên khác' })
    .addUserOption(option =>
      option
        .setName('user')
        .setNameLocalizations({ vi: 'nguoidung' })
        .setDescription('User to become the new owner')
        .setDescriptionLocalizations({ vi: 'Người sẽ trở thành owner mới' })
        .setRequired(true)
    ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

async function registerCommands() {
  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Command registration error:', error);
  }
}

client.once('clientReady', async () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const member = interaction.member;

  if (!guild || !member) {
    return interaction.reply({
      content: '❌ This command can only be used in a server.\n❌ Lệnh này chỉ dùng trong server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'createteam' || interaction.commandName === 'taoteam') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const rawTeamName =
      interaction.options.getString('name') ??
      interaction.options.getString('ten');

    const rawColor =
      interaction.options.getString('color') ??
      interaction.options.getString('mau');

    if (!rawTeamName || !rawColor) {
      return interaction.editReply(
        '❌ Missing team name or color.\n❌ Thiếu tên team hoặc mã màu.'
      );
    }

    const teamName = rawTeamName.trim();
    const roleName = `${TEAM_PREFIX}${teamName}`;
    const channelName = makeSafeChannelName(teamName);
    const hexColor = normalizeHexColor(rawColor);

    if (!channelName || channelName.length < 3) {
      return interaction.editReply(
        '❌ Invalid team name.\n❌ Tên team không hợp lệ.'
      );
    }

    if (!hexColor) {
      return interaction.editReply(
        '❌ Invalid HEX color. Use `#FF6600` or `FF6600`.\n❌ Mã màu HEX không hợp lệ. Dùng `#FF6600` hoặc `FF6600`.'
      );
    }

    try {
      const existingUserTeamRole = findMemberTeamRole(member);
      if (existingUserTeamRole) {
        return interaction.editReply(
          `❌ You already have a team: **${existingUserTeamRole.name}**\n` +
          `❌ Bạn đã có team rồi: **${existingUserTeamRole.name}**`
        );
      }

      const existingRole = guild.roles.cache.find(
        role => role.name.toLowerCase() === roleName.toLowerCase()
      );
      if (existingRole) {
        return interaction.editReply(
          '❌ This team name already exists.\n❌ Tên team này đã tồn tại.'
        );
      }

      const existingChannel = guild.channels.cache.find(
        channel => channel.name === channelName
      );
      if (existingChannel) {
        return interaction.editReply(
          '❌ This team channel already exists.\n❌ Kênh team này đã tồn tại.'
        );
      }

      const botMember = getBotMember(guild);
      if (!botMember) {
        return interaction.editReply(
          '❌ Bot could not resolve its own guild member.\n❌ Bot không lấy được thông tin của chính nó trong server.'
        );
      }

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply(
          '❌ Bot is missing Manage Roles permission.\n❌ Bot đang thiếu quyền Manage Roles.'
        );
      }

      if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.editReply(
          '❌ Bot is missing Manage Channels permission.\n❌ Bot đang thiếu quyền Manage Channels.'
        );
      }

      const teamRole = await guild.roles.create({
        name: roleName,
        color: hexColor,
        mentionable: true,
        reason: `Team created by ${interaction.user.tag}`,
      });

      await member.roles.add(teamRole, 'Team owner role assigned');

      const teamChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: process.env.CATEGORY_ID || null,
        topic: buildTeamTopic({
          ownerId: interaction.user.id,
          roleId: teamRole.id,
          teamName,
        }),
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: teamRole.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ],
        reason: `Private team channel for ${roleName}`,
      });

      await teamChannel.send(
        `🎉 Welcome / Chào mừng <@${interaction.user.id}>!\n` +
        `Team: **${teamRole.name}**\n` +
        `Owner: <@${interaction.user.id}>\n` +
        `Color / Màu: **${hexColor}**`
      );

      return interaction.editReply(
        `✅ Team created successfully\n` +
        `✅ Tạo team thành công\n\n` +
        `• Role: **${teamRole.name}**\n` +
        `• Color / Màu: **${hexColor}**\n` +
        `• Channel: ${teamChannel}`
      );
    } catch (error) {
      console.error('❌ Error creating team:', error);
      return interaction.editReply(
        '❌ Failed to create team.\n❌ Có lỗi khi tạo team.'
      );
    }
  }

  if (interaction.commandName === 'invite' || interaction.commandName === 'moi') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser =
      interaction.options.getUser('user') ??
      interaction.options.getUser('nguoidung');

    if (!targetUser) {
      return interaction.editReply(
        '❌ User not found.\n❌ Không tìm thấy người dùng.'
      );
    }

    if (targetUser.bot) {
      return interaction.editReply(
        '❌ You cannot invite a bot.\n❌ Không thể mời bot vào team.'
      );
    }

    if (targetUser.id === interaction.user.id) {
      return interaction.editReply(
        '❌ You are already in your own team.\n❌ Bạn đã ở trong team của mình rồi.'
      );
    }

    try {
      const teamData = resolveTeamData(guild, member, interaction.user.id);
      if (!teamData || !teamData.teamRole || !teamData.teamChannel || !teamData.meta) {
        return interaction.editReply(
          '❌ You do not have a valid team.\n❌ Bạn chưa có team hợp lệ.'
        );
      }

      if (teamData.meta.ownerId !== interaction.user.id) {
        return interaction.editReply(
          '❌ Only the team owner can invite members.\n❌ Chỉ owner team mới có thể mời thành viên.'
        );
      }

      const targetMember = await fetchGuildMember(guild, targetUser.id);
      if (!targetMember) {
        return interaction.editReply(
          '❌ This user is not in the server.\n❌ Người này không có trong server.'
        );
      }

      const targetHasTeam = findMemberTeamRole(targetMember);
      if (targetHasTeam) {
        return interaction.editReply(
          `❌ This user is already in **${targetHasTeam.name}**.\n` +
          `❌ Người này đã ở trong **${targetHasTeam.name}** rồi.`
        );
      }

      const botMember = getBotMember(guild);
      if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply(
          '❌ Bot is missing Manage Roles permission.\n❌ Bot đang thiếu quyền Manage Roles.'
        );
      }

      if (botMember.roles.highest.position <= teamData.teamRole.position) {
        return interaction.editReply(
          '❌ Bot role must be above the team role.\n❌ Role bot phải cao hơn role team.'
        );
      }

      await targetMember.roles.add(
        teamData.teamRole,
        `Invited by ${interaction.user.tag}`
      );

      await teamData.teamChannel.send(
        `✅ <@${targetUser.id}> joined **${teamData.teamRole.name}**\n` +
        `✅ <@${targetUser.id}> đã vào **${teamData.teamRole.name}**`
      );

      return interaction.editReply(
        `✅ Added <@${targetUser.id}> to **${teamData.teamRole.name}**\n` +
        `✅ Đã thêm <@${targetUser.id}> vào **${teamData.teamRole.name}**`
      );
    } catch (error) {
      console.error('❌ Invite error:', error);
      return interaction.editReply(
        '❌ Failed to invite member.\n❌ Có lỗi khi mời thành viên.'
      );
    }
  }

  if (interaction.commandName === 'kick' || interaction.commandName === 'duoi') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser =
      interaction.options.getUser('user') ??
      interaction.options.getUser('nguoidung');

    if (!targetUser) {
      return interaction.editReply(
        '❌ User not found.\n❌ Không tìm thấy người dùng.'
      );
    }

    try {
      const teamData = resolveTeamData(guild, member, interaction.user.id);
      if (!teamData || !teamData.teamRole || !teamData.teamChannel || !teamData.meta) {
        return interaction.editReply(
          '❌ You do not have a valid team.\n❌ Bạn chưa có team hợp lệ.'
        );
      }

      if (teamData.meta.ownerId !== interaction.user.id) {
        return interaction.editReply(
          '❌ Only the team owner can kick members.\n❌ Chỉ owner team mới có thể kick thành viên.'
        );
      }

      if (targetUser.id === interaction.user.id) {
        return interaction.editReply(
          '❌ You cannot kick yourself. Use `/leave` or `/delete-team`.\n❌ Bạn không thể tự kick mình. Hãy dùng `/leave` hoặc `/delete-team`.'
        );
      }

      const targetMember = await fetchGuildMember(guild, targetUser.id);
      if (!targetMember) {
        return interaction.editReply(
          '❌ This user is not in the server.\n❌ Người này không có trong server.'
        );
      }

      if (!targetMember.roles.cache.has(teamData.teamRole.id)) {
        return interaction.editReply(
          '❌ This user is not in your team.\n❌ Người này không ở trong team của bạn.'
        );
      }

      const botMember = getBotMember(guild);
      if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply(
          '❌ Bot is missing Manage Roles permission.\n❌ Bot đang thiếu quyền Manage Roles.'
        );
      }

      if (botMember.roles.highest.position <= teamData.teamRole.position) {
        return interaction.editReply(
          '❌ Bot role must be above the team role.\n❌ Role bot phải cao hơn role team.'
        );
      }

      await targetMember.roles.remove(
        teamData.teamRole,
        `Kicked by ${interaction.user.tag}`
      );

      await teamData.teamChannel.send(
        `⚠️ <@${targetUser.id}> was removed from **${teamData.teamRole.name}**\n` +
        `⚠️ <@${targetUser.id}> đã bị loại khỏi **${teamData.teamRole.name}**`
      );

      return interaction.editReply(
        `✅ Removed <@${targetUser.id}> from **${teamData.teamRole.name}**\n` +
        `✅ Đã loại <@${targetUser.id}> khỏi **${teamData.teamRole.name}**`
      );
    } catch (error) {
      console.error('❌ Kick error:', error);
      return interaction.editReply(
        '❌ Failed to kick member.\n❌ Có lỗi khi kick thành viên.'
      );
    }
  }

  if (interaction.commandName === 'leave' || interaction.commandName === 'roiteam') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const teamData = getTeamDataByMember(guild, member);
      if (!teamData || !teamData.teamRole) {
        return interaction.editReply(
          '❌ You are not in any team.\n❌ Bạn chưa ở trong team nào.'
        );
      }

      const isOwner = teamData.meta && teamData.meta.ownerId === interaction.user.id;
      if (isOwner) {
        return interaction.editReply(
          '❌ Team owner cannot leave directly. Use `/delete-team`.\n❌ Owner team không thể rời trực tiếp. Hãy dùng `/delete-team`.'
        );
      }

      const botMember = getBotMember(guild);
      if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply(
          '❌ Bot is missing Manage Roles permission.\n❌ Bot đang thiếu quyền Manage Roles.'
        );
      }

      if (botMember.roles.highest.position <= teamData.teamRole.position) {
        return interaction.editReply(
          '❌ Bot role must be above the team role.\n❌ Role bot phải cao hơn role team.'
        );
      }

      await member.roles.remove(
        teamData.teamRole,
        'User left the team'
      );

      if (teamData.teamChannel) {
        await teamData.teamChannel.send(
          `👋 <@${interaction.user.id}> left **${teamData.teamRole.name}**\n` +
          `👋 <@${interaction.user.id}> đã rời **${teamData.teamRole.name}**`
        );
      }

      return interaction.editReply(
        `✅ You left **${teamData.teamRole.name}**\n` +
        `✅ Bạn đã rời **${teamData.teamRole.name}**`
      );
    } catch (error) {
      console.error('❌ Leave error:', error);
      return interaction.editReply(
        '❌ Failed to leave the team.\n❌ Có lỗi khi rời team.'
      );
    }
  }

  if (interaction.commandName === 'transfer-owner' || interaction.commandName === 'chuyenchu') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser =
      interaction.options.getUser('user') ??
      interaction.options.getUser('nguoidung');

    if (!targetUser) {
      return interaction.editReply(
        '❌ User not found.\n❌ Không tìm thấy người dùng.'
      );
    }

    if (targetUser.bot) {
      return interaction.editReply(
        '❌ You cannot transfer ownership to a bot.\n❌ Bạn không thể chuyển quyền owner cho bot.'
      );
    }

    if (targetUser.id === interaction.user.id) {
      return interaction.editReply(
        '❌ You are already the owner.\n❌ Bạn đã là owner rồi.'
      );
    }

    try {
      const teamData = resolveTeamData(guild, member, interaction.user.id);

      if (!teamData || !teamData.teamRole || !teamData.teamChannel || !teamData.meta) {
        return interaction.editReply(
          '❌ You do not have a valid team.\n❌ Bạn chưa có team hợp lệ.'
        );
      }

      if (teamData.meta.ownerId !== interaction.user.id) {
        return interaction.editReply(
          '❌ Only the current owner can transfer ownership.\n❌ Chỉ owner hiện tại mới có thể chuyển quyền.'
        );
      }

      const targetMember = await fetchGuildMember(guild, targetUser.id);
      if (!targetMember) {
        return interaction.editReply(
          '❌ This user is not in the server.\n❌ Người này không có trong server.'
        );
      }

      if (!targetMember.roles.cache.has(teamData.teamRole.id)) {
        return interaction.editReply(
          '❌ This user is not in your team.\n❌ Người này không ở trong team của bạn.'
        );
      }

      const teamName =
        teamData.meta.teamName ||
        teamData.teamRole.name.replace(TEAM_PREFIX, '');

      await updateTeamChannelOwner(
        teamData.teamChannel,
        targetUser.id,
        teamData.teamRole.id,
        teamName
      );

      await teamData.teamChannel.send(
        `👑 Ownership of **${teamData.teamRole.name}** has been transferred to <@${targetUser.id}>\n` +
        `👑 Quyền owner của **${teamData.teamRole.name}** đã được chuyển cho <@${targetUser.id}>`
      );

      return interaction.editReply(
        `✅ Ownership transferred to <@${targetUser.id}>.\n` +
        `✅ Đã chuyển quyền owner cho <@${targetUser.id}>.`
      );
    } catch (error) {
      console.error('❌ Transfer owner error:', error);
      return interaction.editReply(
        '❌ Failed to transfer ownership.\n❌ Có lỗi khi chuyển quyền owner.'
      );
    }
  }

  if (interaction.commandName === 'delete-team' || interaction.commandName === 'xoateam') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const teamData = resolveTeamForDelete(guild, member, interaction.user.id);

      console.log('DELETE_TEAM_DEBUG', {
        userId: interaction.user.id,
        roleId: teamData?.teamRole?.id || null,
        channelId: teamData?.teamChannel?.id || null,
        meta: teamData?.meta || null,
      });

      if (!teamData || (!teamData.teamRole && !teamData.teamChannel)) {
        return interaction.editReply(
          '❌ Team không được tìm thấy. Có thể role hoặc channel đã bị xoá thủ công.\n' +
          '❌ Team not found. The role or channel may have been deleted manually.'
        );
      }

      if (teamData.meta?.ownerId && teamData.meta.ownerId !== interaction.user.id) {
        return interaction.editReply(
          '❌ Chỉ owner team mới có thể xoá team.\n' +
          '❌ Only the team owner can delete the team.'
        );
      }

      const precheckError = getDeletePrecheck(guild, teamData);
      if (precheckError) {
        return interaction.editReply(`❌ ${precheckError}`);
      }

      if (teamData.teamChannel) {
        try {
          await teamData.teamChannel.delete(`Deleted by ${interaction.user.tag}`);
          console.log('✅ Channel deleted');
        } catch (err) {
          console.error('❌ Channel delete failed:', err);
          return interaction.editReply(
            '❌ Bot không xoá được channel. Hãy kiểm tra quyền Manage Channels.\n' +
            '❌ Bot could not delete the channel. Check Manage Channels permission.'
          );
        }
      }

      if (teamData.teamRole) {
        try {
          await teamData.teamRole.delete(`Deleted by ${interaction.user.tag}`);
          console.log('✅ Role deleted');
        } catch (err) {
          console.error('❌ Role delete failed:', err);
          return interaction.editReply(
            '❌ Bot không xoá được role. Hãy kiểm tra Manage Roles và vị trí role của bot.\n' +
            '❌ Bot could not delete the role. Check Manage Roles and bot role position.'
          );
        }
      }

      return interaction.editReply(
        '✅ Team deleted successfully.\n✅ Đã xoá team thành công.'
      );
    } catch (error) {
      console.error('❌ Delete team error:', error);
      return interaction.editReply(
        '❌ Failed to delete the team.\n❌ Có lỗi khi xoá team.'
      );
    }
  }
});

client.login(process.env.TOKEN);
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
});