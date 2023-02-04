import { Guild, GuildChannel, TextChannel } from "discord.js";
import { commandTypeHelpers as ct } from "../../../commandTypes";
import { sendErrorMessage } from "../../../pluginUtils";
import { noop } from "../../../utils.js";
import { botControlCmd } from "../types";

export const ChannelToServerCmd = botControlCmd({
  trigger: ["channel_to_server", "channel2server"],
  permission: "can_admin",

  signature: {
    channelId: ct.string(),
  },

  async run({ pluginData, message: msg, args }) {
    const channel = await pluginData.client.channels.fetch(args.channelId).catch(noop);
    if (!channel) {
      sendErrorMessage(pluginData, msg.channel as TextChannel, "Channel not found!");
      return;
    }

    const channelName = channel.isVoice() ? channel.name : `#${(channel as TextChannel).name}`;

    const guild: Guild | null = (channel as GuildChannel).guild ?? null;
    const guildInfo = guild ? `${guild.name} (\`${guild.id}\`)` : "Not a server";

    msg.channel.send(`**Channel:** ${channelName} (\`${channel.type}\`) (<#${channel.id}>)\n**Server:** ${guildInfo}`);
  },
});
