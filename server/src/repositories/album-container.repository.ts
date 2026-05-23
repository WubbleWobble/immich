import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AlbumUserRole } from 'src/enum';
import { DB } from 'src/schema';

@Injectable()
export class AlbumContainerRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db.selectFrom('album_container').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, name: DummyValue.STRING, parentId: DummyValue.UUID }] })
  async create(payload: { ownerId: string; name: string; parentId: string | null }) {
    return this.db.transaction().execute(async (tx) => {
      const container = await tx
        .insertInto('album_container')
        .values({ ownerId: payload.ownerId, name: payload.name, parentId: payload.parentId })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Self closure row (depth 0)
      await tx
        .insertInto('album_container_closure')
        .values({ id_ancestor: container.id, id_descendant: container.id, depth: 0 })
        .execute();

      // Inherit ancestor rows from parent (depth + 1) if there is a parent.
      if (payload.parentId) {
        await tx
          .insertInto('album_container_closure')
          .columns(['id_ancestor', 'id_descendant', 'depth'])
          .expression((eb) =>
            eb
              .selectFrom('album_container_closure')
              .select([
                'id_ancestor',
                sql.raw<string>(`'${container.id}'`).as('id_descendant'),
                sql<number>`depth + 1`.as('depth'),
              ])
              .where('id_descendant', '=', payload.parentId!),
          )
          .execute();
      }

      return container;
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async move(containerId: string, newParentId: string | null) {
    return this.db.transaction().execute(async (tx) => {
      // 1. Remove closure rows that connect the moved subtree to nodes outside of it.
      //    These are rows where `id_descendant` is in the moved subtree but `id_ancestor` is not.
      await tx
        .deleteFrom('album_container_closure')
        .where('id_descendant', 'in', (eb) =>
          eb.selectFrom('album_container_closure').select('id_descendant').where('id_ancestor', '=', containerId),
        )
        .where('id_ancestor', 'not in', (eb) =>
          eb.selectFrom('album_container_closure').select('id_descendant').where('id_ancestor', '=', containerId),
        )
        .execute();

      // 2. Update the parent pointer.
      const updated = await tx
        .updateTable('album_container')
        .set({ parentId: newParentId })
        .where('id', '=', containerId)
        .returningAll()
        .executeTakeFirstOrThrow();

      // 3. Attach the moved subtree under the new parent (if any).
      //    For each (ancestor A of new parent) x (descendant D of moved container)
      //    insert (A, D, A.depth + D.depth + 1).
      if (newParentId) {
        await tx
          .insertInto('album_container_closure')
          .columns(['id_ancestor', 'id_descendant', 'depth'])
          .expression((eb) =>
            eb
              .selectFrom('album_container_closure as parent_anc')
              .innerJoin('album_container_closure as moved_desc', (join) => join.onTrue())
              .select([
                'parent_anc.id_ancestor as id_ancestor',
                'moved_desc.id_descendant as id_descendant',
                sql<number>`parent_anc.depth + moved_desc.depth + 1`.as('depth'),
              ])
              .where('parent_anc.id_descendant', '=', newParentId)
              .where('moved_desc.id_ancestor', '=', containerId),
          )
          .execute();
      }

      return updated;
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('album_container').where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForUser(userId: string) {
    return this.db
      .selectFrom('album_container')
      .selectAll('album_container')
      .where((eb) =>
        eb.or([
          eb('album_container.ownerId', '=', userId),
          eb.exists(
            eb
              .selectFrom('album_container_user')
              .innerJoin(
                'album_container_closure',
                'album_container_closure.id_ancestor',
                'album_container_user.albumContainerId',
              )
              .whereRef('album_container_closure.id_descendant', '=', 'album_container.id')
              .where('album_container_user.userId', '=', userId),
          ),
        ]),
      )
      .where('album_container.deletedAt', 'is', null)
      .orderBy('album_container.name', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async isDescendantOf(containerId: string, ancestorId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('album_container_closure')
      .select('depth')
      .where('id_ancestor', '=', ancestorId)
      .where('id_descendant', '=', containerId)
      .where('depth', '>', 0)
      .executeTakeFirst();
    return row !== undefined;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getDepth(containerId: string): Promise<number> {
    const row = await this.db
      .selectFrom('album_container_closure')
      .select((eb) => eb.fn.max('depth').as('maxDepth'))
      .where('id_descendant', '=', containerId)
      .executeTakeFirst();
    return Number(row?.maxDepth ?? 0);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async rename(id: string, name: string) {
    return this.db
      .updateTable('album_container')
      .set({ name })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, AlbumUserRole.Editor] })
  async addUser(albumContainerId: string, userId: string, role: AlbumUserRole) {
    return this.db
      .insertInto('album_container_user')
      .values({ albumContainerId, userId, role })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async removeUser(albumContainerId: string, userId: string) {
    await this.db
      .deleteFrom('album_container_user')
      .where('albumContainerId', '=', albumContainerId)
      .where('userId', '=', userId)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, AlbumUserRole.Editor] })
  async updateUserRole(albumContainerId: string, userId: string, role: AlbumUserRole) {
    return this.db
      .updateTable('album_container_user')
      .set({ role })
      .where('albumContainerId', '=', albumContainerId)
      .where('userId', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
