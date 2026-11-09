import { BadRequestException } from '@nestjs/common';
import {
  InsertQueryNode,
  Kysely,
  KyselyPlugin,
  QueryId,
  RootOperationNode,
  TableNode,
  UpdateQueryNode,
  sql,
} from 'kysely';
import { AlbumUserRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumContainerRepository } from 'src/repositories/album-container.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumContainerService } from 'src/services/album-container.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB, getKyselyPeerDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;
// A second, independent pool: the race tests run each actor's transaction on its own real connection.
let peerDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AlbumContainerService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumContainerRepository,
      AlbumRepository,
      AlbumUserRepository,
      LockRepository,
      UserRepository,
    ],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  peerDatabase = await getKyselyPeerDB(defaultDatabase);
});

afterAll(async () => {
  await peerDatabase.destroy();
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const tableOf = (node: RootOperationNode) => {
  const target = UpdateQueryNode.is(node) ? node.table : InsertQueryNode.is(node) ? node.into : undefined;
  return target && TableNode.is(target) ? target.table.identifier.name : undefined;
};

/**
 * A handle on `db` whose first UPDATE/INSERT into `table` is held after it executed - still
 * inside its transaction, uncommitted - until released. Lets a test land a second actor's
 * work in exactly that window.
 */
const gateAfter = (db: Kysely<DB>, kind: 'UpdateQueryNode' | 'InsertQueryNode', table: string) => {
  const reached = deferred();
  const released = deferred();
  const held = new WeakSet<QueryId>();
  let armed = true;
  const plugin: KyselyPlugin = {
    transformQuery: ({ node, queryId }) => {
      if (armed && node.kind === kind && tableOf(node) === table) {
        armed = false;
        held.add(queryId);
      }
      return node;
    },
    transformResult: async ({ queryId, result }) => {
      if (held.has(queryId)) {
        reached.resolve();
        await released.promise;
      }
      return result;
    },
  };
  return { db: db.withPlugin(plugin), reached: reached.promise, release: released.resolve };
};

const isQueuedOnAdvisoryLock = async (db: Kysely<DB>) => {
  const { rows } = await sql<{ waiting: number }>`
    SELECT count(*)::int AS waiting FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `.execute(db);
  return rows[0].waiting > 0;
};

/**
 * Waits until the second actor can make no further progress on its own: it finished, it
 * reached its own gate, or its connection is queued on an advisory lock (the serialized case).
 */
const untilSecondActorStops = async (work: Promise<unknown>, reached?: Promise<void>) => {
  let state: 'settled' | 'reached' | undefined;
  void work.catch(() => {}).finally(() => (state ??= 'settled'));
  void reached?.then(() => (state ??= 'reached'));
  for (let attempt = 0; attempt < 500; attempt++) {
    if (state) {
      return state;
    }
    if (await isQueuedOnAdvisoryLock(defaultDatabase)) {
      return 'blocked';
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('second actor neither finished, reached its gate nor queued on a lock');
};

const rejectionOf = (results: PromiseSettledResult<unknown>[]) => {
  expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
  return (results.find(({ status }) => status === 'rejected') as PromiseRejectedResult).reason;
};

type Ctx = ReturnType<typeof setup>['ctx'];

const newChain = async (ctx: Ctx, ownerId: string, length: number, name: string) => {
  const repository = ctx.get(AlbumContainerRepository);
  const chain = [];
  let parentId: string | null = null;
  for (let index = 0; index < length; index++) {
    const container = await repository.create({ ownerId, name: `${name}${index}`, parentId });
    chain.push(container);
    parentId = container.id;
  }
  return chain;
};

describe(AlbumContainerService.name, () => {
  describe('structural serialization', () => {
    it('create child under P racing a move of P from shared A to private D leaves no (A, C) closure row', async () => {
      const { ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: sharee } = await ctx.newUser();
      const auth = factory.auth({ user: owner });
      const repository = ctx.get(AlbumContainerRepository);
      const a = await repository.create({ ownerId: owner.id, name: 'A', parentId: null });
      const p = await repository.create({ ownerId: owner.id, name: 'P', parentId: a.id });
      const d = await repository.create({ ownerId: owner.id, name: 'D', parentId: null });
      await repository.addUser(a.id, sharee.id, AlbumUserRole.Viewer);

      // The move has removed P's old ancestor links and re-pointed P, but not committed.
      const mover = gateAfter(defaultDatabase, 'UpdateQueryNode', 'album_container');
      const moving = setup(mover.db).sut.update(auth, p.id, { parentId: d.id });
      const creating = (async () => {
        await mover.reached;
        return setup(peerDatabase).sut.create(auth, { name: 'C', parentId: p.id });
      })();
      try {
        await mover.reached;
        await untilSecondActorStops(creating);
      } finally {
        mover.release();
      }
      const [, c] = await Promise.all([moving, creating]);

      expect(await repository.getById(p.id)).toMatchObject({ parentId: d.id });
      expect(c.parentId).toBe(p.id);
      await ctx.expectClosureMatchesParents(owner.id);

      // C is structurally under private D, so A's share must not reach an album placed in C.
      const { album } = await ctx.newAlbum({ ownerId: owner.id, containerId: c.id });
      await expect(
        ctx.get(AccessRepository).album.checkSharedAlbumAccess(sharee.id, new Set([album.id]), AlbumUserRole.Viewer),
      ).resolves.toEqual(new Set());
    });

    it('opposing concurrent moves cannot create a cycle', async () => {
      const { ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const auth = factory.auth({ user: owner });
      const repository = ctx.get(AlbumContainerRepository);
      const x = await repository.create({ ownerId: owner.id, name: 'X', parentId: null });
      const y = await repository.create({ ownerId: owner.id, name: 'Y', parentId: null });

      // Each move is held after attaching its closure rows, before commit.
      const first = gateAfter(defaultDatabase, 'InsertQueryNode', 'album_container_closure');
      const second = gateAfter(peerDatabase, 'InsertQueryNode', 'album_container_closure');
      const moveX = setup(first.db).sut.update(auth, x.id, { parentId: y.id });
      const moveY = (async () => {
        await first.reached;
        return setup(second.db).sut.update(auth, y.id, { parentId: x.id });
      })();
      try {
        await first.reached;
        await untilSecondActorStops(moveY, second.reached);
      } finally {
        first.release();
        second.release();
      }

      const reason = rejectionOf(await Promise.allSettled([moveX, moveY]));
      expect(reason).toBeInstanceOf(BadRequestException);
      expect(reason.message).toBe('Cannot move a folder into its own descendant');
      await ctx.expectClosureMatchesParents(owner.id);
    });

    it('concurrent moves cannot exceed the depth limit', async () => {
      const { ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const auth = factory.auth({ user: owner });
      // Chains of 6 (height 5): A + B and B + C each fit (tail depth 11), A + B + C does not (17 > 16).
      const chainA = await newChain(ctx, owner.id, 6, 'A');
      const chainB = await newChain(ctx, owner.id, 6, 'B');
      const chainC = await newChain(ctx, owner.id, 6, 'C');

      const first = gateAfter(defaultDatabase, 'InsertQueryNode', 'album_container_closure');
      const second = gateAfter(peerDatabase, 'InsertQueryNode', 'album_container_closure');
      const moveB = setup(first.db).sut.update(auth, chainB[0].id, { parentId: chainA.at(-1)!.id });
      const moveC = (async () => {
        await first.reached;
        return setup(second.db).sut.update(auth, chainC[0].id, { parentId: chainB.at(-1)!.id });
      })();
      try {
        await first.reached;
        await untilSecondActorStops(moveC, second.reached);
      } finally {
        first.release();
        second.release();
      }

      const reason = rejectionOf(await Promise.allSettled([moveB, moveC]));
      expect(reason).toBeInstanceOf(BadRequestException);
      expect(reason.message).toBe('Folder depth exceeds limit of 16');
      await ctx.expectClosureMatchesParents(owner.id);
    });

    it("serialization is per owner: two owners' mutations do not block each other", async () => {
      const { ctx } = setup();
      const { user: owner1 } = await ctx.newUser();
      const { user: owner2 } = await ctx.newUser();
      const repository = ctx.get(AlbumContainerRepository);
      const p = await repository.create({ ownerId: owner1.id, name: 'P', parentId: null });
      const d = await repository.create({ ownerId: owner1.id, name: 'D', parentId: null });

      // Owner 1's move holds its structure lock (uncommitted) while owner 2 creates a folder.
      const mover = gateAfter(defaultDatabase, 'UpdateQueryNode', 'album_container');
      const moving = setup(mover.db).sut.update(factory.auth({ user: owner1 }), p.id, { parentId: d.id });
      const creating = (async () => {
        await mover.reached;
        return setup(peerDatabase).sut.create(factory.auth({ user: owner2 }), { name: 'Other' });
      })();
      let state: string;
      try {
        await mover.reached;
        state = await untilSecondActorStops(creating);
      } finally {
        mover.release();
      }
      await Promise.all([moving, creating]);

      expect(state).toBe('settled');
      await ctx.expectClosureMatchesParents(owner1.id);
      await ctx.expectClosureMatchesParents(owner2.id);
    });
  });
});
