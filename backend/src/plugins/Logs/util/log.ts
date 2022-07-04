import * as t from "io-ts";
import { MessageEmbedOptions, MessageMentionTypes, Snowflake, TextChannel } from "discord.js";
import { GuildPluginData } from "knub";
import { allowTimeout } from "../../../RegExpRunner";
import { ILogTypeData, LogsPluginType, TLogChannel, TLogChannelMap } from "../types";
import { getLogMessage } from "./getLogMessage";
import { TypedTemplateSafeValueContainer } from "../../../templateFormatter";
import { LogType } from "../../../data/LogType";
import { MessageBuffer } from "../../../utils/MessageBuffer";
import { isDiscordAPIError, MINUTES } from "../../../utils";
import { InternalPosterPlugin } from "../../InternalPoster/InternalPosterPlugin";
import { getCategoryThread } from "./getCategoryThread";
import { getObjectId, validateCategoryData } from "./getCategoryObjectId";

const excludedUserProps = ["user", "member", "mod"];
const excludedRoleProps = ["message.member.roles", "member.roles"];

function isRoleArray(value: any): value is string[] {
  return Array.isArray(value);
}

interface ExclusionData {
  userId?: Snowflake | null;
  bot?: boolean | null;
  roles?: Snowflake[] | null;
  channel?: Snowflake | null;
  category?: Snowflake | null;
  messageTextContent?: string | null;
}

const DEFAULT_BATCH_TIME = 1000;
const MIN_BATCH_TIME = 250;
const MAX_BATCH_TIME = 5000;

async function shouldExclude(
  pluginData: GuildPluginData<LogsPluginType>,
  opts: TLogChannel,
  exclusionData: ExclusionData,
): Promise<boolean> {
  if (opts.excluded_users && exclusionData.userId && opts.excluded_users.includes(exclusionData.userId)) {
    return true;
  }

  if (opts.exclude_bots && exclusionData.bot) {
    return true;
  }

  if (opts.excluded_roles && exclusionData.roles) {
    for (const role of exclusionData.roles) {
      if (opts.excluded_roles.includes(role)) {
        return true;
      }
    }
  }

  if (opts.excluded_channels && exclusionData.channel && opts.excluded_channels.includes(exclusionData.channel)) {
    return true;
  }

  if (opts.excluded_categories && exclusionData.category && opts.excluded_categories.includes(exclusionData.category)) {
    return true;
  }

  if (opts.excluded_message_regexes && exclusionData.messageTextContent) {
    for (const regex of opts.excluded_message_regexes) {
      const matches = await pluginData.state.regexRunner
        .exec(regex, exclusionData.messageTextContent)
        .catch(allowTimeout);
      if (matches) {
        return true;
      }
    }
  }

  return false;
}

export async function log<TLogType extends keyof ILogTypeData>(
  pluginData: GuildPluginData<LogsPluginType>,
  type: TLogType,
  data: TypedTemplateSafeValueContainer<ILogTypeData[TLogType]>,
  exclusionData: ExclusionData = {},
) {
  const logChannels: TLogChannelMap = pluginData.config.get().channels;

  logChannelLoop: for (let [channelId, opts] of Object.entries(logChannels)) {
    const channelCheck = pluginData.guild.channels.cache.get(channelId as Snowflake);
    if (!channelCheck || channelCheck.isVoice() || (!channelCheck.isText() && !channelCheck.isThread())) continue;

    const typeStr = LogType[type];

    if (pluginData.state.channelCooldowns.isOnCooldown(channelId)) continue;
    if (opts.include?.length && !opts.include.includes(typeStr)) continue;
    if (opts.exclude && opts.exclude.includes(typeStr)) continue;
    if (await shouldExclude(pluginData, opts, exclusionData)) continue;

    const message = await getLogMessage(pluginData, type, data, {
      format: opts.format,
      include_embed_timestamp: opts.include_embed_timestamp,
      timestamp_format: opts.timestamp_format,
    });
    if (!message) continue;

    if (opts.categorize) {
      if (channelCheck.isThread() || !validateCategoryData(opts.categorize, data)) continue;
      // check object types for current log

      const objectId = getObjectId(opts.categorize, data);
      if (!objectId) continue;
      const catThread = await getCategoryThread(pluginData, channelCheck, objectId);
      if (!catThread) {
        continue;
      }
      channelId = catThread.id;
    }
    const channel = pluginData.guild.channels.cache.get(channelId as Snowflake);
    if (!channel || (!channel.isText() && !channel.isThread())) continue;

    // Initialize message buffer for this channel
    if (!pluginData.state.buffers.has(channelId)) {
      const batchTime = Math.min(Math.max(opts.batch_time ?? DEFAULT_BATCH_TIME, MIN_BATCH_TIME), MAX_BATCH_TIME);
      const internalPosterPlugin = pluginData.getPlugin(InternalPosterPlugin);
      pluginData.state.buffers.set(
        channelId,
        new MessageBuffer({
          timeout: batchTime,
          textSeparator: "\n",
          consume: (part) => {
            const parse: MessageMentionTypes[] = pluginData.config.get().allow_user_mentions ? ["users"] : [];
            internalPosterPlugin
              .sendMessage(channel, {
                ...part,
                allowedMentions: { parse },
              })
              .catch((err) => {
                if (isDiscordAPIError(err)) {
                  // Missing Access / Missing Permissions
                  // TODO: Show/log this somewhere
                  if (err.code === 50001 || err.code === 50013) {
                    pluginData.state.channelCooldowns.setCooldown(channelId, 2 * MINUTES);
                    return;
                  }
                }

                // tslint:disable-next-line:no-console
                console.warn(
                  `Error while sending ${typeStr} log to ${pluginData.guild.id}/${channelId}: ${err.message}`,
                  `${part?.embeds?.length} embeds | ${part?.content?.length} contentlength`,
                );
              });
          },
        }),
      );
    }

    // Add log message to buffer
    const buffer = pluginData.state.buffers.get(channelId)!;
    buffer.push({
      content: typeof message === "string" ? message : message.content || "",
      embeds: typeof message === "string" ? [] : ((message.embeds || []) as MessageEmbedOptions[]),
    });
  }
}
