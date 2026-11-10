import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { VideoStreamRepository } from 'src/repositories/video-stream.repository.js';
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
  return { ctx, sut: new VideoStreamRepository(db || defaultDatabase) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(VideoStreamRepository.name, () => {
  /** Fork (F4): a session is only found together with its own backing asset. */
  describe('getSession', () => {
    it('finds a live session only through its own asset', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: privateVideo } = await ctx.newAsset({ ownerId: user.id });
      const { asset: visibleVideo } = await ctx.newAsset({ ownerId: user.id });
      const sessionId = newUuid();
      await sut.createSession({ id: sessionId, assetId: privateVideo.id, expiresAt: new Date(Date.now() + 60_000) });

      await expect(sut.getSession(sessionId, privateVideo.id)).resolves.toEqual(
        expect.objectContaining({ id: sessionId, assetId: privateVideo.id }),
      );
      await expect(sut.getSession(sessionId, visibleVideo.id)).resolves.toBeUndefined();
      await expect(sut.getSession(newUuid(), privateVideo.id)).resolves.toBeUndefined();
    });

    it('does not find an expired session', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sessionId = newUuid();
      await sut.createSession({ id: sessionId, assetId: asset.id, expiresAt: new Date(Date.now() - 1000) });

      await expect(sut.getSession(sessionId, asset.id)).resolves.toBeUndefined();
    });
  });
});
