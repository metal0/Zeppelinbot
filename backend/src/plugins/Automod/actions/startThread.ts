import { GuildFeature, ThreadAutoArchiveDuration } from "discord-api-types";
import { TextChannel, ThreadEditData } from "discord.js";
import * as t from "io-ts";
import { renderTemplate, TemplateSafeValueContainer } from "../../../templateFormatter";
import { ChannelTypeStrings } from "../../../types";
import { convertDelayStringToMS, MINUTES, noop, tDelayString, tNullable } from "../../../utils";
import { savedMessageToTemplateSafeSavedMessage, userToTemplateSafeUser } from "../../../utils/templateSafeObjects";
import { automodAction } from "../helpers";

const validThreadAutoArchiveDurations: ThreadAutoArchiveDuration[] = [
  ThreadAutoArchiveDuration.OneHour,
  ThreadAutoArchiveDuration.OneDay,
  ThreadAutoArchiveDuration.ThreeDays,
  ThreadAutoArchiveDuration.OneWeek,
];

export const StartThreadAction = automodAction({
  configType: t.type({
    name: tNullable(t.string),
    auto_archive: tNullable(tDelayString),
    private: tNullable(t.boolean),
    slowmode: tNullable(tDelayString),
    lock: tNullable(t.boolean),
    invitable: tNullable(t.boolean),
    limit_per_channel: tNullable(t.number),
  }),

  defaultConfig: {
    limit_per_channel: 5,
  },

  async apply({ pluginData, contexts, actionConfig, ruleName }) {
    // check if the message still exists, we don't want to create threads for deleted messages
    const threads = await Promise.all(
      contexts.filter(async (c) => {
        if (!c.message || !c.user) return false;
        const channel = await pluginData.guild.channels.fetch(c.message.channel_id).catch(noop);
        if (channel?.type !== ChannelTypeStrings.TEXT || !channel.isText()) return false; // for some reason the typing here for channel.type defaults to ThreadChannelTypes (?)
        // check against max threads per channel
        if (actionConfig.limit_per_channel && actionConfig.limit_per_channel > 0) {
          const threadCount = channel.threads.cache.filter(
            (tr) =>
              tr.ownerId === pluginData.client.user!.id && !tr.deleted && !tr.archived && tr.parentId === channel.id,
          ).size;
          if (threadCount >= actionConfig.limit_per_channel) return false;
        }
        return true;
      }),
    );

    const guild = pluginData.guild;
    const archiveSet = actionConfig.auto_archive
      ? Math.ceil(Math.max(convertDelayStringToMS(actionConfig.auto_archive) ?? 0, 0) / MINUTES)
      : ThreadAutoArchiveDuration.OneDay;
    const autoArchive = validThreadAutoArchiveDurations.includes(archiveSet)
      ? (archiveSet as ThreadAutoArchiveDuration)
      : ThreadAutoArchiveDuration.OneHour;

    for (const c of threads) {
      const channel = (await pluginData.guild.channels.fetch(c.message!.channel_id).catch(noop)) as TextChannel;
      const renderThreadName = async (str) =>
        renderTemplate(
          str,
          new TemplateSafeValueContainer({
            user: userToTemplateSafeUser(c.user!),
            msg: savedMessageToTemplateSafeSavedMessage(c.message!),
          }),
        );
      const threadName = await renderThreadName(actionConfig.name ?? "{user.tag}s thread");
      const thread = await channel.threads
        .create({
          name: threadName,
          autoArchiveDuration: autoArchive,
          type:
            actionConfig.private && guild.features.includes(GuildFeature.PrivateThreads)
              ? ChannelTypeStrings.PRIVATE_THREAD
              : ChannelTypeStrings.PUBLIC_THREAD,
          startMessage:
            !actionConfig.private && guild.features.includes(GuildFeature.PrivateThreads) ? c.message!.id : undefined,
        })
        .catch(noop);
      if (!thread) {
        return;
      }
      // post-actions
      const opts: ThreadEditData = {};
      if (actionConfig.slowmode) {
        const dur = Math.ceil(Math.max(convertDelayStringToMS(actionConfig.slowmode) ?? 0, 0) / 1000);
        if (dur > 0) {
          opts.rateLimitPerUser = dur;
        }
      }
      if (actionConfig.lock) {
        opts.locked = true;
      }
      if (
        actionConfig.private &&
        typeof actionConfig.invitable === "boolean" &&
        thread.type === ChannelTypeStrings.PRIVATE_THREAD
      ) {
        opts.invitable = actionConfig.invitable;
      }
      if (Object.keys(opts).length > 0) {
        await thread.edit(opts).catch(noop);
      }
    }
  },
});
