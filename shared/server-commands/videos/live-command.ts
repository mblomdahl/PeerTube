/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { readdir } from 'fs-extra'
import { join } from 'path'
import { omit, wait } from '@shared/core-utils'
import {
  HttpStatusCode,
  LiveVideo,
  LiveVideoCreate,
  LiveVideoSession,
  LiveVideoUpdate,
  ResultList,
  VideoCreateResult,
  VideoDetails,
  VideoPrivacy,
  VideoState
} from '@shared/models'
import { unwrapBody } from '../requests'
import { ObjectStorageCommand, PeerTubeServer } from '../server'
import { AbstractCommand, OverrideCommandOptions } from '../shared'
import { sendRTMPStream, testFfmpegStreamError } from './live'

export class LiveCommand extends AbstractCommand {

  get (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const path = '/api/v1/videos/live'

    return this.getRequestBody<LiveVideo>({
      ...options,

      path: path + '/' + options.videoId,
      implicitToken: true,
      defaultExpectedStatus: HttpStatusCode.OK_200
    })
  }

  // ---------------------------------------------------------------------------

  listSessions (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const path = `/api/v1/videos/live/${options.videoId}/sessions`

    return this.getRequestBody<ResultList<LiveVideoSession>>({
      ...options,

      path,
      implicitToken: true,
      defaultExpectedStatus: HttpStatusCode.OK_200
    })
  }

  async findLatestSession (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const { data: sessions } = await this.listSessions(options)

    return sessions[sessions.length - 1]
  }

  getReplaySession (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const path = `/api/v1/videos/${options.videoId}/live-session`

    return this.getRequestBody<LiveVideoSession>({
      ...options,

      path,
      implicitToken: true,
      defaultExpectedStatus: HttpStatusCode.OK_200
    })
  }

  // ---------------------------------------------------------------------------

  update (options: OverrideCommandOptions & {
    videoId: number | string
    fields: LiveVideoUpdate
  }) {
    const { videoId, fields } = options
    const path = '/api/v1/videos/live'

    return this.putBodyRequest({
      ...options,

      path: path + '/' + videoId,
      fields,
      implicitToken: true,
      defaultExpectedStatus: HttpStatusCode.NO_CONTENT_204
    })
  }

  async create (options: OverrideCommandOptions & {
    fields: LiveVideoCreate
  }) {
    const { fields } = options
    const path = '/api/v1/videos/live'

    const attaches: any = {}
    if (fields.thumbnailfile) attaches.thumbnailfile = fields.thumbnailfile
    if (fields.previewfile) attaches.previewfile = fields.previewfile

    const body = await unwrapBody<{ video: VideoCreateResult }>(this.postUploadRequest({
      ...options,

      path,
      attaches,
      fields: omit(fields, [ 'thumbnailfile', 'previewfile' ]),
      implicitToken: true,
      defaultExpectedStatus: HttpStatusCode.OK_200
    }))

    return body.video
  }

  async quickCreate (options: OverrideCommandOptions & {
    saveReplay: boolean
    permanentLive: boolean
    privacy?: VideoPrivacy
  }) {
    const { saveReplay, permanentLive, privacy } = options

    const { uuid } = await this.create({
      ...options,

      fields: {
        name: 'live',
        permanentLive,
        saveReplay,
        replaySettings: { privacy },
        channelId: this.server.store.channel.id,
        privacy
      }
    })

    const video = await this.server.videos.getWithToken({ id: uuid })
    const live = await this.get({ videoId: uuid })

    return { video, live }
  }

  // ---------------------------------------------------------------------------

  async sendRTMPStreamInVideo (options: OverrideCommandOptions & {
    videoId: number | string
    fixtureName?: string
    copyCodecs?: boolean
  }) {
    const { videoId, fixtureName, copyCodecs } = options
    const videoLive = await this.get({ videoId })

    return sendRTMPStream({ rtmpBaseUrl: videoLive.rtmpUrl, streamKey: videoLive.streamKey, fixtureName, copyCodecs })
  }

  async runAndTestStreamError (options: OverrideCommandOptions & {
    videoId: number | string
    shouldHaveError: boolean
  }) {
    const command = await this.sendRTMPStreamInVideo(options)

    return testFfmpegStreamError(command, options.shouldHaveError)
  }

  // ---------------------------------------------------------------------------

  waitUntilPublished (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const { videoId } = options
    return this.waitUntilState({ videoId, state: VideoState.PUBLISHED })
  }

  waitUntilWaiting (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const { videoId } = options
    return this.waitUntilState({ videoId, state: VideoState.WAITING_FOR_LIVE })
  }

  waitUntilEnded (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    const { videoId } = options
    return this.waitUntilState({ videoId, state: VideoState.LIVE_ENDED })
  }

  async waitUntilSegmentGeneration (options: OverrideCommandOptions & {
    server: PeerTubeServer
    videoUUID: string
    playlistNumber: number
    segment: number
    objectStorage: boolean
    objectStorageBaseUrl?: string
  }) {
    const {
      server,
      objectStorage,
      playlistNumber,
      segment,
      videoUUID,
      objectStorageBaseUrl = ObjectStorageCommand.getMockPlaylistBaseUrl()
    } = options

    const segmentName = `${playlistNumber}-00000${segment}.ts`
    const baseUrl = objectStorage
      ? join(objectStorageBaseUrl, 'hls')
      : server.url + '/static/streaming-playlists/hls'

    let error = true

    while (error) {
      try {
        await this.getRawRequest({
          ...options,

          url: `${baseUrl}/${videoUUID}/${segmentName}`,
          implicitToken: false,
          defaultExpectedStatus: HttpStatusCode.OK_200
        })

        const video = await server.videos.get({ id: videoUUID })
        const hlsPlaylist = video.streamingPlaylists[0]

        const shaBody = await server.streamingPlaylists.getSegmentSha256({ url: hlsPlaylist.segmentsSha256Url })

        if (!shaBody[segmentName]) {
          throw new Error('Segment SHA does not exist')
        }

        error = false
      } catch {
        error = true
        await wait(100)
      }
    }
  }

  async waitUntilReplacedByReplay (options: OverrideCommandOptions & {
    videoId: number | string
  }) {
    let video: VideoDetails

    do {
      video = await this.server.videos.getWithToken({ token: options.token, id: options.videoId })

      await wait(500)
    } while (video.isLive === true || video.state.id !== VideoState.PUBLISHED)
  }

  // ---------------------------------------------------------------------------

  getSegmentFile (options: OverrideCommandOptions & {
    videoUUID: string
    playlistNumber: number
    segment: number
    objectStorage?: boolean // default false
  }) {
    const { playlistNumber, segment, videoUUID, objectStorage = false } = options

    const segmentName = `${playlistNumber}-00000${segment}.ts`
    const baseUrl = objectStorage
      ? ObjectStorageCommand.getMockPlaylistBaseUrl()
      : `${this.server.url}/static/streaming-playlists/hls`

    const url = `${baseUrl}/${videoUUID}/${segmentName}`

    return this.getRawRequest({
      ...options,

      url,
      implicitToken: false,
      defaultExpectedStatus: HttpStatusCode.OK_200
    })
  }

  getPlaylistFile (options: OverrideCommandOptions & {
    videoUUID: string
    playlistName: string
    objectStorage?: boolean // default false
  }) {
    const { playlistName, videoUUID, objectStorage = false } = options

    const baseUrl = objectStorage
      ? ObjectStorageCommand.getMockPlaylistBaseUrl()
      : `${this.server.url}/static/streaming-playlists/hls`

    const url = `${baseUrl}/${videoUUID}/${playlistName}`

    return this.getRawRequest({
      ...options,

      url,
      implicitToken: false,
      defaultExpectedStatus: HttpStatusCode.OK_200
    })
  }

  // ---------------------------------------------------------------------------

  async countPlaylists (options: OverrideCommandOptions & {
    videoUUID: string
  }) {
    const basePath = this.server.servers.buildDirectory('streaming-playlists')
    const hlsPath = join(basePath, 'hls', options.videoUUID)

    const files = await readdir(hlsPath)

    return files.filter(f => f.endsWith('.m3u8')).length
  }

  private async waitUntilState (options: OverrideCommandOptions & {
    videoId: number | string
    state: VideoState
  }) {
    let video: VideoDetails

    do {
      video = await this.server.videos.getWithToken({ token: options.token, id: options.videoId })

      await wait(500)
    } while (video.state.id !== options.state)
  }
}
