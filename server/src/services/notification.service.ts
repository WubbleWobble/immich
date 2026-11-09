import { BadRequestException, Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { EmailImageAttachment, JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { MapAlbumDto } from 'src/dtos/album.dto.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemConfigSmtpDto } from 'src/dtos/config.dto.js';
import {
  NotificationDeleteAllDto,
  NotificationDto,
  NotificationSearchDto,
  NotificationUpdateAllDto,
  NotificationUpdateDto,
  mapNotification,
} from 'src/dtos/notification.dto.js';
import {
  AssetFileType,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  Permission,
  QueueName,
} from 'src/enum.js';
import { EmailTemplate } from 'src/repositories/email.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { LockService } from 'src/services/lock.service.js';
import { getFilenameExtension } from 'src/utils/file.js';
import { getExternalDomain } from 'src/utils/misc.js';
import { isEqualObject } from 'src/utils/object.js';
import { getPreferences } from 'src/utils/preferences.js';

@Injectable()
export class NotificationService extends BaseService {
  private lockService() {
    return BaseService.create(LockService, this);
  }

  private static albumUpdateEmailDelayMs = 300_000;

  async search(auth: AuthDto, dto: NotificationSearchDto): Promise<NotificationDto[]> {
    const items = await this.notificationRepository.search(auth.user.id, dto);
    // Fork (R58): outside elevation, a notification about a hidden album or asset is not listed (see sendNotification).
    const hidden = auth.session?.hasElevatedPermission
      ? new Set<string>()
      : await this.lockService().getHiddenNotificationIds(auth.user.id, items);
    return items.filter(({ id }) => !hidden.has(id)).map((item) => mapNotification(item));
  }

  /** Fork (R58): a notification about hidden content reads as missing outside elevation (ruling R32). */
  private async assertNotificationVisible(auth: AuthDto, item: { id: string; data: unknown }) {
    if (auth.session?.hasElevatedPermission) {
      return;
    }
    const hidden = await this.lockService().getHiddenNotificationIds(auth.user.id, [item]);
    if (hidden.has(item.id)) {
      throw new BadRequestException('Notification not found');
    }
  }

  /**
   * Fork (R58): the `on_notification` push follows the recipient's lock state - a notification about an album or asset
   * hidden for the recipient outside elevation reaches only their elevated sessions.
   */
  private async sendNotification(userId: string, item: Parameters<typeof mapNotification>[0]) {
    const hidden = await this.lockService().getHiddenNotificationIds(userId, [item]);
    for (const room of await this.lockService().getOwnerEventRooms(userId, hidden.has(item.id))) {
      this.websocketRepository.clientSend('on_notification', room, mapNotification(item));
    }
  }

  async updateAll(auth: AuthDto, dto: NotificationUpdateAllDto) {
    await this.requireAccess({ auth, ids: dto.ids, permission: Permission.NotificationUpdate });
    await this.notificationRepository.updateAll(dto.ids, {
      readAt: dto.readAt,
    });
  }

  async deleteAll(auth: AuthDto, dto: NotificationDeleteAllDto) {
    await this.requireAccess({ auth, ids: dto.ids, permission: Permission.NotificationDelete });
    await this.notificationRepository.deleteAll(dto.ids);
  }

  async get(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, ids: [id], permission: Permission.NotificationRead });
    const item = await this.notificationRepository.get(id);
    if (!item) {
      throw new BadRequestException('Notification not found');
    }
    await this.assertNotificationVisible(auth, item);
    return mapNotification(item);
  }

  async update(auth: AuthDto, id: string, dto: NotificationUpdateDto) {
    await this.requireAccess({ auth, ids: [id], permission: Permission.NotificationUpdate });
    const [existing] = await this.notificationRepository.search(auth.user.id, { id });
    if (existing) {
      await this.assertNotificationVisible(auth, existing);
    }
    const item = await this.notificationRepository.update(id, {
      readAt: dto.readAt,
    });
    return mapNotification(item);
  }

  async delete(auth: AuthDto, id: string) {
    await this.requireAccess({ auth, ids: [id], permission: Permission.NotificationDelete });
    await this.notificationRepository.delete(id);
  }

  @OnJob({ name: JobName.NotificationsCleanup, queue: QueueName.BackgroundTask })
  async onNotificationsCleanup() {
    await this.notificationRepository.cleanup();
  }

  @OnEvent({ name: 'JobError' })
  async onJobError({ job, error }: ArgOf<'JobError'>) {
    const admin = await this.userRepository.getAdmin();
    if (!admin) {
      return;
    }

    this.logger.error(`Unable to run job handler (${job.name}): ${error}`, error?.stack, JSON.stringify(job.data));

    switch (job.name) {
      case JobName.DatabaseBackup: {
        const errorMessage = error instanceof Error ? error.message : error;
        const item = await this.notificationRepository.create({
          userId: admin.id,
          type: NotificationType.JobFailed,
          level: NotificationLevel.Error,
          title: 'Job Failed',
          description: `Job ${[job.name]} failed with error: ${errorMessage}`,
        });

        await this.sendNotification(admin.id, item);
        break;
      }

      default: {
        return;
      }
    }
  }

  @OnEvent({ name: 'ConfigUpdate' })
  onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    this.websocketRepository.clientBroadcast('on_config_update');
    this.websocketRepository.serverSend('ConfigUpdate', { oldConfig, newConfig });
  }

  @OnEvent({ name: 'AppRestart' })
  onAppRestart(state: ArgOf<'AppRestart'>) {
    this.websocketRepository.clientBroadcast('AppRestartV1', {
      isMaintenanceMode: state.isMaintenanceMode,
    });

    this.websocketRepository.serverSend('AppRestart', state);
  }

  @OnEvent({ name: 'ConfigValidate', priority: -100 })
  async onConfigValidate({ oldConfig, newConfig }: ArgOf<'ConfigValidate'>) {
    try {
      if (
        newConfig.notifications.smtp.enabled &&
        !isEqualObject(oldConfig.notifications.smtp, newConfig.notifications.smtp)
      ) {
        await this.emailRepository.verifySmtp(newConfig.notifications.smtp.transport);
      }
    } catch (error: Error | any) {
      this.logger.error(`Failed to validate SMTP configuration: ${error}`, error?.stack);
      throw new Error('Invalid SMTP configuration', { cause: error });
    }
  }

  @OnEvent({ name: 'AssetHide' })
  async onAssetHide({ assetId, userId }: ArgOf<'AssetHide'>) {
    // Fork (R58): the id of a lock-hidden asset reaches only the owner's elevated sessions.
    const [{ rooms }] = await this.lockService().getOwnerEventDeliveries([
      { id: assetId, ownerId: userId, livePhotoVideoId: null },
    ]);
    for (const room of rooms) {
      this.websocketRepository.clientSend('on_asset_hidden', room, assetId);
    }
  }

  @OnEvent({ name: 'AssetShow' })
  async onAssetShow({ assetId }: ArgOf<'AssetShow'>) {
    await this.jobRepository.queue({ name: JobName.AssetGenerateThumbnails, data: { id: assetId, notify: true } });
  }

  // Fork (R58, round 2): id-carrying asset events are split - ids hidden for the owner outside elevation reach only
  // the owner's elevated sessions, the rest the owner's user room (see LockService.routeOwnerAssetIds).
  @OnEvent({ name: 'AssetTrash' })
  async onAssetTrash({ assetId, userId }: ArgOf<'AssetTrash'>) {
    await this.sendAssetIds('on_asset_trash', userId, [assetId]);
  }

  /**
   * The asset row is gone by now, so the deletion job judged it beforehand (`hiddenFromOrdinary`): ordinary tabs that
   * never showed a hidden asset do not learn its id from its deletion.
   */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId, userId, hiddenFromOrdinary }: ArgOf<'AssetDelete'>) {
    for (const room of await this.lockService().getOwnerEventRooms(userId, !!hiddenFromOrdinary)) {
      this.websocketRepository.clientSend('on_asset_delete', room, assetId);
    }
  }

  @OnEvent({ name: 'AssetTrashAll' })
  async onAssetsTrash({ assetIds, userId }: ArgOf<'AssetTrashAll'>) {
    await this.sendAssetIds('on_asset_trash', userId, assetIds);
  }

  private async sendAssetIds(event: 'on_asset_trash' | 'on_asset_restore', userId: string, assetIds: string[]) {
    for (const { room, ids } of await this.lockService().routeOwnerAssetIds(userId, assetIds)) {
      this.websocketRepository.clientSend(event, room, ids);
    }
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ assetId, userId, source }: ArgOf<'AssetMetadataExtracted'>) {
    if (source !== 'sidecar-write') {
      return;
    }

    const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([assetId], userId);
    if (!asset) {
      return;
    }

    // Fork (R58): judged under the owner's non-elevated direct rule (see LockService.getOwnerEventDeliveries).
    const [delivery] = await this.lockService().getOwnerEventDeliveries([asset]);
    for (const room of delivery.rooms) {
      this.websocketRepository.clientSend(
        'on_asset_update',
        room,
        mapAsset(delivery.asset, { auth: { user: { id: userId } } as AuthDto }),
      );
    }
  }

  @OnEvent({ name: 'AssetRestoreAll' })
  async onAssetsRestore({ assetIds, userId }: ArgOf<'AssetRestoreAll'>) {
    await this.sendAssetIds('on_asset_restore', userId, assetIds);
  }

  // Fork (R58, round 2): `on_asset_stack_update` carries no ids; a stack an ordinary session does not present (7A.8c:
  // a hidden member and fewer than two visible ones) is announced to the owner's elevated sessions only.
  @OnEvent({ name: 'StackCreate' })
  async onStackCreate({ stackId, userId }: ArgOf<'StackCreate'>) {
    await this.sendStackUpdate(userId, await this.lockService().isStackHiddenForOwnerEvents(userId, stackId));
  }

  @OnEvent({ name: 'StackUpdate' })
  async onStackUpdate({ stackId, userId }: ArgOf<'StackUpdate'>) {
    await this.sendStackUpdate(userId, await this.lockService().isStackHiddenForOwnerEvents(userId, stackId));
  }

  /** Deleted stacks were judged by StackService before deletion (`hiddenFromOrdinary`). */
  @OnEvent({ name: 'StackDelete' })
  async onStackDelete({ userId, hiddenFromOrdinary }: ArgOf<'StackDelete'>) {
    await this.sendStackUpdate(userId, !!hiddenFromOrdinary);
  }

  @OnEvent({ name: 'StackDeleteAll' })
  async onStacksDelete({ userId, hiddenFromOrdinary }: ArgOf<'StackDeleteAll'>) {
    await this.sendStackUpdate(userId, !!hiddenFromOrdinary);
  }

  private async sendStackUpdate(userId: string, hiddenFromOrdinary: boolean) {
    for (const room of await this.lockService().getOwnerEventRooms(userId, hiddenFromOrdinary)) {
      this.websocketRepository.clientSend('on_asset_stack_update', room);
    }
  }

  @OnEvent({ name: 'UserSignup' })
  async onUserSignup({ notify, id, password: password }: ArgOf<'UserSignup'>) {
    if (notify) {
      await this.jobRepository.queue({ name: JobName.NotifyUserSignup, data: { id, password } });
    }
  }

  @OnEvent({ name: 'UserDelete' })
  onUserDelete({ id }: ArgOf<'UserDelete'>) {
    this.websocketRepository.clientBroadcast('on_user_delete', id);
  }

  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ id, userIds, recipientIds }: ArgOf<'AlbumUpdate'>) {
    // Fork (R58): per recipient - an album hidden by the recipient's own locks is announced to their elevated sessions.
    for (const userId of userIds) {
      for (const room of await this.lockService().getAlbumEventRooms(userId, id)) {
        this.websocketRepository.clientSend('on_album_update', room, id);
      }
    }

    for (const recipientId of recipientIds) {
      await this.jobRepository.removeJob(JobName.NotifyAlbumUpdate, `${id}/${recipientId}`);
      await this.jobRepository.queue({
        name: JobName.NotifyAlbumUpdate,
        data: { id, recipientId, delay: NotificationService.albumUpdateEmailDelayMs },
      });
    }
  }

  @OnEvent({ name: 'AlbumInvite' })
  async onAlbumInvite({ id, userId, senderName }: ArgOf<'AlbumInvite'>) {
    await this.jobRepository.queue({ name: JobName.NotifyAlbumInvite, data: { id, recipientId: userId, senderName } });
  }

  @OnEvent({ name: 'ClusterGroupRequest' })
  async onClusterGroupRequest({ clusterGroupId, userId, senderName }: ArgOf<'ClusterGroupRequest'>) {
    const item = await this.notificationRepository.create({
      userId,
      type: NotificationType.ClusterGroupRequest,
      level: NotificationLevel.Info,
      title: 'Cluster Group Request',
      description: `${senderName} asked you to join their cluster group`,
      data: JSON.stringify({ clusterGroupId }),
    });

    await this.sendNotification(userId, item);
  }

  @OnEvent({ name: 'SessionDelete' })
  onSessionDelete({ sessionId }: ArgOf<'SessionDelete'>) {
    // after the response is sent
    setTimeout(() => this.websocketRepository.clientSend('on_session_delete', sessionId, sessionId), 500);
  }

  async sendTestEmail(id: string, dto: SystemConfigSmtpDto, tempTemplate?: string) {
    const user = await this.userRepository.get(id, { withDeleted: false });
    if (!user) {
      throw new Error('User not found');
    }

    try {
      await this.emailRepository.verifySmtp(dto.transport);
    } catch (error) {
      throw new BadRequestException('Failed to verify SMTP configuration', { cause: error });
    }

    const { server } = await this.getConfig({ withCache: false });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.TEST_EMAIL,
      data: {
        baseUrl: getExternalDomain(server),
        displayName: user.name,
      },
      customTemplate: tempTemplate!,
    });
    const { messageId } = await this.emailRepository.sendEmail({
      to: user.email,
      subject: 'Test email from Immich',
      html,
      text,
      from: dto.from,
      replyTo: dto.replyTo || dto.from,
      smtp: dto.transport,
    });

    return { messageId };
  }

  @OnJob({ name: JobName.NotifyUserSignup, queue: QueueName.Notification })
  async handleUserSignup({ id, password }: JobOf<JobName.NotifyUserSignup>) {
    const user = await this.userRepository.get(id, { withDeleted: false });
    if (!user) {
      return JobStatus.Skipped;
    }

    const { server, templates } = await this.getConfig({ withCache: true });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.WELCOME,
      data: {
        baseUrl: getExternalDomain(server),
        displayName: user.name,
        username: user.email,
        password,
      },
      customTemplate: templates.email.welcomeTemplate,
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: user.email,
        subject: 'Welcome to Immich',
        html,
        text,
      },
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NotifyAlbumInvite, queue: QueueName.Notification })
  async handleAlbumInvite({ id, recipientId, senderName }: JobOf<JobName.NotifyAlbumInvite>) {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    if (!album) {
      return JobStatus.Skipped;
    }

    const recipient = await this.userRepository.get(recipientId, { withDeleted: false });
    if (!recipient) {
      return JobStatus.Skipped;
    }

    await this.sendAlbumLocalNotification(album, recipientId, NotificationType.AlbumInvite, senderName);

    const { emailNotifications } = getPreferences(recipient.metadata);

    if (!emailNotifications.enabled || !emailNotifications.albumInvite) {
      return JobStatus.Skipped;
    }

    const attachment = await this.getAlbumThumbnailAttachment(album);

    const { server, templates } = await this.getConfig({ withCache: false });
    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.ALBUM_INVITE,
      data: {
        baseUrl: getExternalDomain(server),
        albumId: album.id,
        albumName: album.albumName,
        senderName,
        recipientName: recipient.name,
        cid: attachment ? attachment.cid : undefined,
      },
      customTemplate: templates.email.albumInviteTemplate,
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: recipient.email,
        subject: `You have been added to a shared album - ${album.albumName}`,
        html,
        text,
        imageAttachments: attachment ? [attachment] : undefined,
      },
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NotifyAlbumUpdate, queue: QueueName.Notification })
  async handleAlbumUpdate({ id, recipientId }: JobOf<JobName.NotifyAlbumUpdate>) {
    const album = await this.albumRepository.getById(id, { withAssets: false });

    if (!album) {
      return JobStatus.Skipped;
    }

    const recipient = await this.userRepository.get(recipientId, { withDeleted: false });
    if (!recipient) {
      return JobStatus.Skipped;
    }

    await this.sendAlbumLocalNotification(album, recipientId, NotificationType.AlbumUpdate);

    const attachment = await this.getAlbumThumbnailAttachment(album);

    const { server, templates } = await this.getConfig({ withCache: false });

    const user = await this.userRepository.get(recipientId, { withDeleted: false });
    if (!user) {
      return JobStatus.Skipped;
    }

    const { emailNotifications } = getPreferences(user.metadata);

    if (!emailNotifications.enabled || !emailNotifications.albumUpdate) {
      return JobStatus.Skipped;
    }

    const { html, text } = await this.emailRepository.renderEmail({
      template: EmailTemplate.ALBUM_UPDATE,
      data: {
        baseUrl: getExternalDomain(server),
        albumId: album.id,
        albumName: album.albumName,
        recipientName: user.name,
        cid: attachment ? attachment.cid : undefined,
      },
      customTemplate: templates.email.albumUpdateTemplate,
    });

    await this.jobRepository.queue({
      name: JobName.SendMail,
      data: {
        to: user.email,
        subject: `New media has been added to an album - ${album.albumName}`,
        html,
        text,
        imageAttachments: attachment ? [attachment] : undefined,
      },
    });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.SendMail, queue: QueueName.Notification })
  async handleSendEmail(data: JobOf<JobName.SendMail>): Promise<JobStatus> {
    const { notifications } = await this.getConfig({ withCache: false });
    if (!notifications.smtp.enabled) {
      return JobStatus.Skipped;
    }

    const { to, subject, html, text: plain } = data;
    const response = await this.emailRepository.sendEmail({
      to,
      subject,
      html,
      text: plain,
      from: notifications.smtp.from,
      replyTo: notifications.smtp.replyTo || notifications.smtp.from,
      smtp: notifications.smtp.transport,
      imageAttachments: data.imageAttachments,
    });

    this.logger.log(`Sent mail with id: ${response.messageId} status: ${response.response}`);

    return JobStatus.Success;
  }

  private async getAlbumThumbnailAttachment(album: {
    albumThumbnailAssetId: string | null;
  }): Promise<EmailImageAttachment | undefined> {
    if (!album.albumThumbnailAssetId) {
      return;
    }

    const albumThumbnailFiles = await this.assetJobRepository.getAlbumThumbnailFiles(
      album.albumThumbnailAssetId,
      AssetFileType.Thumbnail,
    );

    if (albumThumbnailFiles.length !== 1) {
      return;
    }

    return {
      filename: `album-thumbnail${getFilenameExtension(albumThumbnailFiles[0].path)}`,
      path: albumThumbnailFiles[0].path,
      cid: 'album-thumbnail',
    };
  }

  private async sendAlbumLocalNotification(
    album: MapAlbumDto,
    userId: string,
    type: NotificationType.AlbumInvite | NotificationType.AlbumUpdate,
    senderName?: string,
  ) {
    const isInvite = type === NotificationType.AlbumInvite;
    const item = await this.notificationRepository.create({
      userId,
      type,
      level: isInvite ? NotificationLevel.Success : NotificationLevel.Info,
      title: isInvite ? 'Shared Album Invitation' : 'Shared Album Update',
      description: isInvite
        ? `${senderName} shared an album (${album.albumName}) with you`
        : `New media has been added to the album (${album.albumName})`,
      data: JSON.stringify({ albumId: album.id }),
    });

    await this.sendNotification(userId, item);
  }
}
