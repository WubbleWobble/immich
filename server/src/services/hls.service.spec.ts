import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HlsVideoResolution, VideoCodec } from 'src/enum.js';
import { HlsService } from 'src/services/hls.service.js';
import { eiffelTower, train, waterfall } from 'test/fixtures/media.stub.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

// EXTINF values come from FFmpeg's playlist to enforce an exact match
const eiffelExpectedMediaPlaylist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.007222,
seg_0.m4s
#EXTINF:2.007222,
seg_1.m4s
#EXTINF:2.007222,
seg_2.m4s
#EXTINF:2.007222,
seg_3.m4s
#EXTINF:2.007222,
seg_4.m4s
#EXTINF:2.007222,
seg_5.m4s
#EXTINF:2.007222,
seg_6.m4s
#EXTINF:2.007222,
seg_7.m4s
#EXTINF:2.007222,
seg_8.m4s
#EXTINF:2.007222,
seg_9.m4s
#EXTINF:2.007222,
seg_10.m4s
#EXTINF:0.281011,
seg_11.m4s
#EXT-X-ENDLIST
`;

const waterfallExpectedMediaPlaylist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.011405,
seg_0.m4s
#EXTINF:2.011405,
seg_1.m4s
#EXTINF:2.011405,
seg_2.m4s
#EXTINF:2.011405,
seg_3.m4s
#EXTINF:2.011405,
seg_4.m4s
#EXTINF:0.301711,
seg_5.m4s
#EXT-X-ENDLIST
`;

const trainExpectedMediaPlaylist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.000000,
seg_0.m4s
#EXTINF:2.000000,
seg_1.m4s
#EXTINF:2.000000,
seg_2.m4s
#EXTINF:2.000000,
seg_3.m4s
#EXTINF:2.000000,
seg_4.m4s
#EXTINF:2.000000,
seg_5.m4s
#EXTINF:2.000000,
seg_6.m4s
#EXTINF:2.000000,
seg_7.m4s
#EXTINF:2.000000,
seg_8.m4s
#EXTINF:2.000000,
seg_9.m4s
#EXTINF:1.733333,
seg_10.m4s
#EXT-X-ENDLIST
`;

const sessionId = '00000000-0000-0000-0000-000000000000';

const eiffelExpectedMasterAv1 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1350000,RESOLUTION=480x852,CODECS="av01.0.04M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/0/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1620000,RESOLUTION=480x852,CODECS="hvc1.1.6.L90.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/1/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=480x852,CODECS="avc1.64001e,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/2/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=720x1280,CODECS="av01.0.05M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/3/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=720x1280,CODECS="hvc1.1.6.L93.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/4/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6750000,RESOLUTION=720x1280,CODECS="avc1.64001f,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/5/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1080x1920,CODECS="av01.0.08M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/6/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6075000,RESOLUTION=1080x1920,CODECS="hvc1.1.6.L120.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/7/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=10800000,RESOLUTION=1080x1920,CODECS="avc1.640028,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/8/playlist.m3u8
`;

const eiffelExpectedMasterNoAv1 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1620000,RESOLUTION=480x852,CODECS="hvc1.1.6.L90.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/1/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=480x852,CODECS="avc1.64001e,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/2/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=720x1280,CODECS="hvc1.1.6.L93.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/4/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6750000,RESOLUTION=720x1280,CODECS="avc1.64001f,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/5/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6075000,RESOLUTION=1080x1920,CODECS="hvc1.1.6.L120.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/7/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=10800000,RESOLUTION=1080x1920,CODECS="avc1.640028,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=24.910
${sessionId}/8/playlist.m3u8
`;

const waterfallExpectedMasterAv1 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1350000,RESOLUTION=480x852,CODECS="av01.0.04M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/0/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1620000,RESOLUTION=480x852,CODECS="hvc1.1.6.L90.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/1/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=480x852,CODECS="avc1.64001f,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/2/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2700000,RESOLUTION=720x1280,CODECS="av01.0.05M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/3/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3375000,RESOLUTION=720x1280,CODECS="hvc1.1.6.L93.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/4/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6750000,RESOLUTION=720x1280,CODECS="avc1.64001f,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/5/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1080x1920,CODECS="av01.0.08M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/6/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6075000,RESOLUTION=1080x1920,CODECS="hvc1.1.6.L120.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/7/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=10800000,RESOLUTION=1080x1920,CODECS="avc1.640028,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/8/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9450000,RESOLUTION=1440x2560,CODECS="av01.0.12M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/9/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=10800000,RESOLUTION=1440x2560,CODECS="hvc1.1.6.L150.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/10/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=18900000,RESOLUTION=1440x2560,CODECS="avc1.640032,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/11/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=16200000,RESOLUTION=2160x3840,CODECS="av01.0.12M.08,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/12/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=18900000,RESOLUTION=2160x3840,CODECS="hvc1.1.6.L150.B0,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/13/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=33750000,RESOLUTION=2160x3840,CODECS="avc1.640033,mp4a.40.2",VIDEO-RANGE=SDR,FRAME-RATE=29.830
${sessionId}/14/playlist.m3u8
`;

describe(HlsService.name, () => {
  let sut: HlsService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(HlsService));
  });

  describe('getMainPlaylist', () => {
    const auth = factory.auth();
    const assetId = 'asset-1';

    const allCodecs = [VideoCodec.Av1, VideoCodec.Hevc, VideoCodec.H264];
    const allResolutions = [
      HlsVideoResolution.p480,
      HlsVideoResolution.p720,
      HlsVideoResolution.p1080,
      HlsVideoResolution.p1440,
      HlsVideoResolution.p2160,
    ];

    const setup = (
      asset: typeof eiffelTower | typeof waterfall,
      videoCodecs?: VideoCodec[],
      resolutions?: HlsVideoResolution[],
    ) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { realtime: { enabled: true, videoCodecs, resolutions } },
      });
      mocks.videoStream.getForMainPlaylist.mockResolvedValue(asset);
      mocks.crypto.randomUUID.mockReturnValue(sessionId);
      mocks.websocket.serverSend.mockImplementation((event, ...rest) => {
        if (event !== 'HlsSessionRequest') {
          return;
        }

        const { sessionId: id } = rest[0] as { sessionId: string };
        queueMicrotask(() => sut.onSessionResult({ sessionId: id }));
      });
    };

    it('offers AV1, HEVC, and H.264 when AV1 is configured and the accelerator supports it', async () => {
      setup(eiffelTower, allCodecs);
      await expect(sut.getMainPlaylist(auth, assetId)).resolves.toBe(eiffelExpectedMasterAv1);
    });

    it('omits AV1 when it is not in the configured codecs', async () => {
      setup(eiffelTower);
      await expect(sut.getMainPlaylist(auth, assetId)).resolves.toBe(eiffelExpectedMasterNoAv1);
    });

    it('offers every resolution up to the source and derives 4K codec levels (waterfall, 4K, 29.83fps)', async () => {
      setup(waterfall, allCodecs, allResolutions);
      await expect(sut.getMainPlaylist(auth, assetId)).resolves.toBe(waterfallExpectedMasterAv1);
    });

    it('throws BadRequestException when realtime transcoding is disabled', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { realtime: { enabled: false } } });
      await expect(sut.getMainPlaylist(auth, assetId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when asset is not yet ready for streaming', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { realtime: { enabled: true } } });
      await expect(sut.getMainPlaylist(auth, assetId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMediaPlaylist', () => {
    const auth = factory.auth();
    const assetId = 'asset-1';
    const fixtures = [
      { data: eiffelTower, playlist: eiffelExpectedMediaPlaylist },
      { data: waterfall, playlist: waterfallExpectedMediaPlaylist },
      { data: train, playlist: trainExpectedMediaPlaylist },
    ];

    it.each(fixtures)('matches FFmpeg for $data.originalPath', async ({ data, playlist }) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(data);
      await expect(sut.getMediaPlaylist(auth, assetId, sessionId, 0)).resolves.toBe(playlist);
    });

    it('throws NotFoundException when the session/asset cannot be loaded', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      await expect(sut.getMediaPlaylist(auth, assetId, sessionId, 0)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('prewarms transcoding at the segment containing the hinted position', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1, 10.5);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSegmentRequest', {
        sessionId,
        assetId,
        variantIndex: 1,
        segmentIndex: 5,
      });
    });

    it('prewarms from the last requested segment when no hint is given', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      await sut.getSegment(auth, assetId, sessionId, 0, 'seg_5.m4s');

      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSegmentRequest', {
        sessionId,
        assetId,
        variantIndex: 1,
        segmentIndex: 6,
      });
    });

    it('does not prewarm without a hint or prior segment traffic', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });

    it('does not prewarm the variant the session is already playing', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      await sut.getSegment(auth, assetId, sessionId, 1, 'seg_5.m4s');

      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(eiffelTower);
      await sut.getMediaPlaylist(auth, assetId, sessionId, 1, 12.5);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('HlsSegmentRequest', expect.anything());
    });
  });

  describe('getSegment', () => {
    const auth = factory.auth();
    const assetId = 'asset-1';
    const variantIndex = 0;

    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      mocks.storage.checkFileExists.mockResolvedValue(true);
    });

    it('emits HlsHeartbeat with segmentIndex 0 for the first init.mp4 request', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 0,
      });
    });

    it('emits HlsHeartbeat with the parsed segment number for seg_K.m4s', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 5,
      });
    });

    it('returns lastRequested + 1 for init.mp4 without a target segment', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s');
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 6,
      });
    });

    it('updates lastRequested on a backward-seek segment request', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s');
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_3.m4s');
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 4,
      });
    });

    it('tracks segment state per session independently', async () => {
      await sut.getSegment(auth, assetId, 'session-a', variantIndex, 'seg_5.m4s');
      await sut.getSegment(auth, assetId, 'session-b', variantIndex, 'seg_2.m4s');
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, 'session-a', variantIndex, 'init.mp4');
      await sut.getSegment(auth, assetId, 'session-b', variantIndex, 'init.mp4');
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId: 'session-a',
        variantIndex,
        segmentIndex: 6,
      });
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId: 'session-b',
        variantIndex,
        segmentIndex: 3,
      });
    });

    it('rejects pending waiters for the previous variant on variant change', async () => {
      mocks.storage.checkFileExists.mockResolvedValueOnce(false);

      const pending = sut.getSegment(auth, assetId, sessionId, 0, 'seg_1.m4s');
      await new Promise((resolve) => setImmediate(resolve));
      await sut.getSegment(auth, assetId, sessionId, 1, 'seg_1.m4s');

      await expect(pending).rejects.toThrow('Variant changed');
    });

    it('throws NotFoundException when the session does not exist', async () => {
      mocks.videoStream.getSession.mockReset();
      await expect(sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('uses the initSegment hint for init.mp4', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4', 7);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 7,
      });
    });

    it('prefers the initSegment hint over the lastRequested + 1 fallback', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s'); // fallback would be 6
      mocks.websocket.serverSend.mockClear();
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'init.mp4', 10);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 10,
      });
    });

    it('ignores the initSegment hint for media segment requests (the filename wins)', async () => {
      await sut.getSegment(auth, assetId, sessionId, variantIndex, 'seg_5.m4s', 99);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsHeartbeat', {
        sessionId,
        variantIndex,
        segmentIndex: 5,
      });
    });
  });

  describe('endSession', () => {
    it('emits HlsSessionEnd', async () => {
      const auth = factory.auth();
      const assetId = 'asset-1';
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.videoStream.getSession.mockResolvedValue({ id: sessionId, assetId } as never);
      await sut.endSession(auth, assetId, sessionId);
      expect(mocks.videoStream.getSession).toHaveBeenCalledWith(sessionId, assetId);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSessionEnd', { sessionId });
    });

    it('emits nothing for a session that does not exist', async () => {
      const auth = factory.auth();
      const assetId = 'asset-1';
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      await sut.endSession(auth, assetId, sessionId);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });
  });

  /**
   * Fork (F4): every session operation loads the session by (sessionId AND the URL's assetId), like the media playlist,
   * so the asset the access check authorized is the session's backing asset. A session paired with another asset fails
   * exactly like a missing one and emits no heartbeat, segment request or end event.
   */
  describe('session/asset binding', () => {
    const privateVideo = 'private-video';
    const visibleVideo = 'visible-video';
    const session = { id: sessionId, assetId: privateVideo, expiresAt: new Date(Date.now() + 60_000) };

    beforeEach(() => {
      // the row store: a lookup naming an asset only matches the session's own asset
      mocks.videoStream.getSession.mockImplementation(((id: string, assetId?: string) =>
        Promise.resolve(
          id === session.id && (assetId === undefined || assetId === session.assetId) ? session : undefined,
        )) as never);
      // the worker completes any requested segment
      mocks.websocket.serverSend.mockImplementation(((event: string, data: any) => {
        if (event === 'HlsSegmentRequest') {
          setTimeout(() => sut.onSegmentResult({ ...data, success: true }), 0);
        }
      }) as never);
    });

    it('serves the matching pair (existing and newly generated segments)', async () => {
      const auth = factory.auth();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([privateVideo]));
      mocks.storage.checkFileExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(sut.getSegment(auth, privateVideo, sessionId, 0, 'seg_1.m4s')).resolves.toBeDefined();
      await expect(sut.getSegment(auth, privateVideo, sessionId, 0, 'seg_2.m4s')).resolves.toBeDefined();
      expect(mocks.videoStream.getSession).toHaveBeenCalledWith(sessionId, privateVideo);
      expect(mocks.websocket.serverSend.mock.calls.filter(([event]) => event === 'HlsSegmentRequest')).toEqual([
        ['HlsSegmentRequest', { sessionId, assetId: privateVideo, variantIndex: 0, segmentIndex: 2 }],
      ]);
      await sut.endSession(auth, privateVideo, sessionId);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('HlsSessionEnd', { sessionId });
    });

    it.each([
      { segment: 'existing', exists: true },
      { segment: 'not-yet-generated', exists: false },
    ])(
      'refuses a session paired with another readable asset ($segment segment), emitting nothing',
      async ({ exists }) => {
        const auth = factory.auth();
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([visibleVideo]));
        mocks.storage.checkFileExists.mockResolvedValue(exists);

        await expect(sut.getSegment(auth, visibleVideo, sessionId, 0, 'seg_12.m4s')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(sut.getSegment(auth, visibleVideo, sessionId, 0, 'init.mp4')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await sut.endSession(auth, visibleVideo, sessionId);
        expect(mocks.storage.checkFileExists).not.toHaveBeenCalled();
        expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
      },
    );

    it('fails a mismatched pair exactly like a missing session', async () => {
      const auth = factory.auth();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([visibleVideo]));
      const mismatched = await sut.getSegment(auth, visibleVideo, sessionId, 0, 'seg_1.m4s').catch((error) => error);
      const missing = await sut
        .getSegment(auth, visibleVideo, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 0, 'seg_1.m4s')
        .catch((error) => error);
      expect(mismatched).toBeInstanceOf(NotFoundException);
      expect(mismatched.getResponse()).toEqual(missing.getResponse());
    });

    it('refuses the session after an elevated-to-ordinary transition, by its own asset or another', async () => {
      const elevated = factory.auth({ session: { hasElevatedPermission: true } });
      const ordinary = factory.auth({ session: { id: elevated.session!.id }, user: { id: elevated.user.id } });
      mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));
      // the private video is hidden by the viewer's own lock outside elevation
      mocks.access.asset.excludeHiddenForLocker.mockImplementation((_userId, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id !== privateVideo))),
      );
      mocks.storage.checkFileExists.mockResolvedValue(true);
      await expect(sut.getSegment(elevated, privateVideo, sessionId, 0, 'seg_1.m4s')).resolves.toBeDefined();
      mocks.websocket.serverSend.mockClear();

      for (const exists of [true, false]) {
        mocks.storage.checkFileExists.mockResolvedValue(exists);
        await expect(sut.getSegment(ordinary, privateVideo, sessionId, 0, 'seg_1.m4s')).rejects.toThrow();
        await expect(sut.getSegment(ordinary, visibleVideo, sessionId, 0, 'seg_9.m4s')).rejects.toThrow();
      }
      await expect(sut.endSession(ordinary, privateVideo, sessionId)).rejects.toThrow();
      await sut.endSession(ordinary, visibleVideo, sessionId);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });

    it('refuses the session after the partner grant is revoked, by its own asset or another', async () => {
      const auth = factory.auth();
      mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id === visibleVideo))),
      );
      mocks.access.asset.checkPartnerAccess.mockResolvedValueOnce(new Set([privateVideo]));
      mocks.storage.checkFileExists.mockResolvedValue(true);
      await expect(sut.getSegment(auth, privateVideo, sessionId, 0, 'seg_1.m4s')).resolves.toBeDefined();
      mocks.websocket.serverSend.mockClear();

      // revoked: the partner path no longer grants the private video
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set());
      await expect(sut.getSegment(auth, privateVideo, sessionId, 0, 'seg_2.m4s')).rejects.toThrow();
      await expect(sut.getSegment(auth, visibleVideo, sessionId, 0, 'seg_2.m4s')).rejects.toThrow();
      await sut.endSession(auth, visibleVideo, sessionId);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });

    it("confines a shared link to its own assets' sessions", async () => {
      const auth = factory.auth({ sharedLink: {} });
      mocks.access.asset.checkSharedLinkAccess.mockImplementation((_linkId, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id === visibleVideo))),
      );
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.getSegment(auth, privateVideo, sessionId, 0, 'seg_1.m4s')).rejects.toThrow();
      await expect(sut.getSegment(auth, visibleVideo, sessionId, 0, 'seg_1.m4s')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await sut.endSession(auth, visibleVideo, sessionId);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });

    it('does not prewarm a media playlist for a mismatched pair', async () => {
      const auth = factory.auth();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([visibleVideo]));
      mocks.videoStream.getForMediaPlaylist.mockResolvedValue(undefined as never);
      await expect(sut.getMediaPlaylist(auth, visibleVideo, sessionId, 0, 10)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.videoStream.getForMediaPlaylist).toHaveBeenCalledWith(visibleVideo, sessionId);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
    });
  });
});
