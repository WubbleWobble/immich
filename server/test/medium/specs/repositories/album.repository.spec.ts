import { Kysely } from 'kysely';
import { AlbumKind } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumRepository.name, () => {
  describe('getSmartAlbumsForOwnerByPersonIds', () => {
    it("finds the owner's smart albums by a person id that no longer exists (D12: ids dangle, not pruned)", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const deadId = newUuid();
      const liveId = newUuid();
      const { album } = await ctx.newAlbum({
        ownerId: user.id,
        kind: AlbumKind.Smart,
        filter: { personIds: [deadId, liveId] } as any,
      });
      await ctx.newAlbum({ ownerId: other.id, kind: AlbumKind.Smart, filter: { personIds: [deadId] } as any });
      await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Smart, filter: { personIds: [newUuid()] } as any });

      await expect(sut.getSmartAlbumsForOwnerByPersonIds(user.id, [deadId])).resolves.toEqual([{ id: album.id }]);
    });
  });
});
