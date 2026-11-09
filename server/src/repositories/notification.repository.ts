import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { NotificationSearchDto } from 'src/dtos/notification.dto.js';
import { DB } from 'src/schema/index.js';
import { NotificationTable } from 'src/schema/tables/notification.table.js';

export class NotificationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  cleanup() {
    return this.db
      .deleteFrom('notification')
      .where((eb) =>
        eb.or([
          // remove soft-deleted notifications
          eb.and([eb('deletedAt', 'is not', null), eb('deletedAt', '<', DateTime.now().minus({ days: 3 }).toJSDate())]),

          // remove old, read notifications
          eb.and([
            // keep recently read messages around for a few days
            eb('readAt', '>', DateTime.now().minus({ days: 2 }).toJSDate()),
            eb('createdAt', '<', DateTime.now().minus({ days: 15 }).toJSDate()),
          ]),

          eb.and([
            // remove super old, unread notifications
            eb('readAt', '=', null),
            eb('createdAt', '<', DateTime.now().minus({ days: 30 }).toJSDate()),
          ]),
        ]),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, {}] }, { name: 'unread', params: [DummyValue.UUID, { unread: true }] })
  search(userId: string, dto: NotificationSearchDto) {
    return this.db
      .selectFrom('notification')
      .select(columns.notification)
      .where((qb) =>
        qb.and({
          userId,
          id: dto.id,
          level: dto.level,
          type: dto.type,
          readAt: dto.unread ? null : undefined,
        }),
      )
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  /**
   * Fork (R58): the user's own notifications among `ids`, with the data their lock judgement reads. Soft-deleted rows
   * are included on purpose: `get` still answers them within the cleanup window, so they are judged like live ones.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedArray({ paramIndex: 1 })
  getByIds(userId: string, ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('notification')
      .select(['id', 'data'])
      .where('userId', '=', userId)
      .where('id', 'in', ids)
      .execute();
  }

  create(notification: Insertable<NotificationTable>) {
    return this.db
      .insertInto('notification')
      .values(notification)
      .returning(columns.notification)
      .executeTakeFirstOrThrow();
  }

  get(id: string) {
    return this.db
      .selectFrom('notification')
      .select(columns.notification)
      .where('id', '=', id)
      .where('deletedAt', 'is not', null)
      .executeTakeFirst();
  }

  update(id: string, notification: Updateable<NotificationTable>) {
    return this.db
      .updateTable('notification')
      .set(notification)
      .where('deletedAt', 'is', null)
      .where('id', '=', id)
      .returning(columns.notification)
      .executeTakeFirstOrThrow();
  }

  async updateAll(ids: string[], notification: Updateable<NotificationTable>) {
    await this.db.updateTable('notification').set(notification).where('id', 'in', ids).execute();
  }

  async delete(id: string) {
    await this.db
      .updateTable('notification')
      .set({ deletedAt: DateTime.now().toJSDate() })
      .where('id', '=', id)
      .execute();
  }

  async deleteAll(ids: string[]) {
    await this.db
      .updateTable('notification')
      .set({ deletedAt: DateTime.now().toJSDate() })
      .where('id', 'in', ids)
      .execute();
  }
}
