import './embed.scss'

import * as videojs from 'video.js'
import 'videojs-hotkeys'
import '../../assets/player/peertube-videojs-plugin'
import 'videojs-dock/dist/videojs-dock.es.js'
import { VideoDetails } from '../../../../shared'

async function loadVideoInfo (videoId: string) {
  const response = await fetch(window.location.origin + '/api/v1/videos/' + videoId)
  return response.json();
}

const urlParts = window.location.href.split('/')
const videoId = urlParts[urlParts.length - 1]

loadVideoInfo(videoId)
  .then(videoInfo => {
    const videoElement = document.getElementById('video-container') as HTMLVideoElement
    const previewUrl = window.location.origin + videoInfo.previewPath
    videoElement.poster = previewUrl

    const videojsOptions = {
      controls: true,
      autoplay: false,
      plugins: {
        peertube: {
          videoFiles: videoInfo.files,
          playerElement: videoElement,
          peerTubeLink: true
        },
        hotkeys: {
          enableVolumeScroll: false
        }
      }
    }
    videojs('video-container', videojsOptions, function () {
      const player = this

      player.dock({
        title: videoInfo.name
      })
    })
  })
  .catch(err => {
    console.error(err);
  })
