/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const mkdirp = require('mkdirp');
const admin = require('firebase-admin');
admin.initializeApp();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Max height and width of the thumbnail in pixels.
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;
// Thumbnail prefix added to file names.
const THUMB_PREFIX = 'thumb_';

/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 * After the thumbnail has been generated and uploaded to Cloud Storage,
 * we write the public URL to the Firebase Realtime Database.
 */
exports.generateThumbnail = functions.storage.object().onFinalize(async (object) => {
  // File and directory paths.
  const filePath = object.name;
  const contentType = object.contentType; // This is the image MIME type
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
    //console.log("Not a video or image file");
    return;
  }
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const tempLocalFile = path.join(os.tmpdir(), filePath);
  const tempLocalDir = path.dirname(tempLocalFile);
  // Create the temp directory where the storage file will be downloaded.
  await mkdirp(tempLocalDir)
  const bucket = admin.storage().bucket(object.bucket);
  // Download file from bucket.
  const file = bucket.file(filePath);
  await file.download({ destination: tempLocalFile });
  //console.log('The file has been downloaded to', tempLocalFile);

  // Exit if this is triggered on a file that is not an image.
  if (contentType.startsWith('image/')) {
    // Exit if the image is already a thumbnail. This is to prevent new thumb nail file uploaded and trigger another processing of thumbnail 
    if (fileName.startsWith(THUMB_PREFIX)) {
      return;
    }
    const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
    const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);
    // Cloud Storage files.

    const metadata = {
      contentType: contentType,
      'Cache-Control': 'public,max-age=3600',
    };
    // Generate a thumbnail using ImageMagick.
    await spawn('convert', [tempLocalFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile], { capture: ['stdout', 'stderr'] });
    //console.log('Thumbnail created at', tempLocalThumbFile);
    // Uploading the Thumbnail.
    await bucket.upload(tempLocalThumbFile, {
      destination: thumbFilePath,
      public: true,
      metadata: metadata
    });
    //console.log('Thumbnail uploaded to Storage at', thumbFilePath);
    fs.unlinkSync(tempLocalThumbFile);
    fs.unlinkSync(tempLocalFile);
  } else if (contentType.startsWith('video/')) {
    // This is to prevent triggering another converting mp4 file after already convert
    var codec = await getCodec(tempLocalFile);
    console.log("Codec of file is: " + codec);
    if (codec === "h264") {
      return;
    }
    if (fileName.endsWith('_output.mp4')) {
      return;
    }
    const mp4FilePath = path.normalize(path.join(fileDir, fileName.replace(/\.[^/.]+$/, '') + '_output.mp4'));
    const targetTempFilePath = path.join(os.tmpdir(), mp4FilePath);
    await convertFile(tempLocalFile, targetTempFilePath);
    await bucket.upload(targetTempFilePath, {
      destination: mp4FilePath,
      uploadType: 'media',
      resumable: false,
      public: true,
      metadata: { gzip: true, cacheControl: "public, max-age=31536000" }
    });
    //console.log('Mp4 uploaded to Storage at', mp4FilePath);
    // Once the image has been uploaded delete the local files to free up disk space.
    fs.unlinkSync(targetTempFilePath);
    fs.unlinkSync(tempLocalFile);
  }
});

function getCodec(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      } else {
        var videoCodec = null;
        metadata.streams.forEach((stream) => {
          if (stream.codec_type === "video") {
            videoCodec = stream.codec_name;
            return resolve(videoCodec);
          }
        });
      }
    });
  })
}


function convertFile(input, output) {
  return new Promise((resolve, reject) => {
    //console.log("Entering converting file");
    ffmpeg(input)
      .format("mp4")
      .videoCodec("libx264")
      .on('error', (err) => {
        console.log("Error in converting file");
        reject(err);
      })
      .on('end', () => {
        console.log("Success in converting file");
        resolve(output);
      }).saveToFile(output);
  });
}