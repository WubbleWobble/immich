import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LockRepository } from 'src/repositories/lock.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetFileService } from 'src/services/asset-file.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(AssetFileService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetFileRepository, AssetRepository, LockRepository, PartnerRepository],
    mock: [JobRepository, LoggingRepository],
  });

  ctx.getMock(JobRepository).queue.mockResolvedValue();

  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetFileService.name, () => {
  describe('fork locks', () => {
    it('asset file list/get/download deny assets hidden by locks', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });

      const newFileAsset = async () => {
        const { asset } = await ctx.newAsset({ ownerId: owner.id });
        await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/preview/${asset.id}.jpg` });
        const file = await ctx.database
          .selectFrom('asset_file')
          .select('id')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow();
        return { asset, fileId: file.id };
      };

      const visible = await newFileAsset();
      const hidden = await newFileAsset();
      const { album: locked } = await ctx.newAlbum({ ownerId: owner.id }, [hidden.asset.id]);
      await ctx.get(LockRepository).lockAlbum(owner.id, locked.id);

      const READ_ERROR = 'Not found or no asset.read access';
      const FILE_READ_ERROR = 'Not found or no assetFile.read access';
      const FILE_DOWNLOAD_ERROR = 'Not found or no assetFile.download access';
      const FILE_DELETE_ERROR = 'Not found or no assetFile.delete access';

      const plain = factory.auth({ user: owner });
      // the visible asset's files stay reachable
      await expect(sut.search(plain, { assetId: visible.asset.id })).resolves.toEqual([
        expect.objectContaining({ id: visible.fileId }),
      ]);
      await expect(sut.get(plain, visible.fileId)).resolves.toEqual(expect.objectContaining({ id: visible.fileId }));
      await expect(sut.download(plain, visible.fileId)).resolves.toEqual(
        expect.objectContaining({ path: `/preview/${visible.asset.id}.jpg` }),
      );

      // the hidden asset's files are unreachable by known id outside an elevated session, reveal header or not
      const revealingUnelevated = { ...plain, revealedLocks: { albumIds: [locked.id], containerIds: [] } };
      for (const auth of [plain, revealingUnelevated] as AuthDto[]) {
        await expect(sut.search(auth, { assetId: hidden.asset.id })).rejects.toThrow(READ_ERROR);
        await expect(sut.get(auth, hidden.fileId)).rejects.toThrow(FILE_READ_ERROR);
        await expect(sut.download(auth, hidden.fileId)).rejects.toThrow(FILE_DOWNLOAD_ERROR);
        // hidden content is write-protected (spec §15.2)
        await expect(sut.delete(auth, hidden.fileId)).rejects.toThrow(FILE_DELETE_ERROR);
      }
      await expect(
        ctx.database.selectFrom('asset_file').select('id').where('id', '=', hidden.fileId).execute(),
      ).resolves.toHaveLength(1);

      // a partner never reaches the owner's hidden asset, elevated or not (the owner's locks apply, spec §4)
      const partnerElevated = factory.auth({ user: partner, session: { hasElevatedPermission: true } });
      await expect(sut.search(partnerElevated, { assetId: hidden.asset.id })).rejects.toThrow(READ_ERROR);
      await expect(sut.search(partnerElevated, { assetId: visible.asset.id })).resolves.toHaveLength(1);
      await expect(sut.get(partnerElevated, hidden.fileId)).rejects.toThrow(FILE_READ_ERROR);
      await expect(sut.download(partnerElevated, hidden.fileId)).rejects.toThrow(FILE_DOWNLOAD_ERROR);

      // direct-by-id access: an elevated owner session bypasses the lock (spec §15.3)
      const elevated = factory.auth({ user: owner, session: { hasElevatedPermission: true } });
      await expect(sut.search(elevated, { assetId: hidden.asset.id })).resolves.toEqual([
        expect.objectContaining({ id: hidden.fileId }),
      ]);
      await expect(sut.get(elevated, hidden.fileId)).resolves.toEqual(expect.objectContaining({ id: hidden.fileId }));
      await expect(sut.download(elevated, hidden.fileId)).resolves.toEqual(
        expect.objectContaining({ path: `/preview/${hidden.asset.id}.jpg` }),
      );
    });
  });
});
