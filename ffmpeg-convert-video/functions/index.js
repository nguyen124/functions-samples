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
const THUMB_MAX_HEIGHT = 300;
const THUMB_MAX_WIDTH = 300;
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
  if (!contentType.toLowerCase().startsWith('image/') && !contentType.toLowerCase().startsWith('video/')) {
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
  if (contentType.toLowerCase().startsWith('image/')) {
    // Exit if the image is already a thumbnail. This is to prevent new thumb nail file uploaded and trigger another processing of thumbnail 
    if (fileName.toLowerCase().startsWith(THUMB_PREFIX) || fileName.toLowerCase().endsWith('_poster.jpg')) {
      return;
    }
    var picDimensions = await getDimentions(tempLocalFile);
    if (picDimensions.width < THUMB_MAX_WIDTH && picDimensions.height < THUMB_MAX_HEIGHT) {
      return;
    }
    //console.log('Enter creating thumbnail image');
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
    //console.log('Thumbnail image uploaded to Storage at', thumbFilePath);
    fs.unlinkSync(tempLocalThumbFile);
    fs.unlinkSync(tempLocalFile);
  } else if (contentType.toLowerCase().startsWith('video/')) {
    // This is to prevent triggering another converting mp4 file after already convert
    if (fileName.toLowerCase().endsWith('_output.mp4')) {
      return;
    }
    var codec = await getCodec(tempLocalFile);
    //console.log("Codec of file " + tempLocalFile + " is: " + codec);
    // we only convert video which has codec not h264
    if (codec !== "h264") {
      const mp4FilePath = path.normalize(path.join(fileDir, fileName.replace(/\.[^/.]+$/, '_output.mp4')));
      const targetTempFilePath = path.join(os.tmpdir(), mp4FilePath);
      await convertFile(tempLocalFile, targetTempFilePath, '100%');
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
    }

    await createPoster(bucket, filePath, tempLocalFile);

    var dimensions = await getDimentions(tempLocalFile);
    //create thumb for video
    var reduceHeightPercentage = 0,
      reduceWidthPercentage = 0;
    if (dimensions.height > 480) {
      reduceHeightPercentage = 100 - ((dimensions.height - 480) / dimensions.height) * 100;
    }
    if (dimensions.width > 425) {
      reduceWidthPercentage = 100 - ((dimensions.width - 425) / dimensions.width) * 100;
    }
    var reduce = Math.floor(reduceHeightPercentage < reduceWidthPercentage ? reduceHeightPercentage : reduceWidthPercentage);
    if (reduce > 0) {
      //console.log("Original width: " + dimensions.width + ". Original height: " + dimensions.height);
      //console.log("create video thumb with percentage:", reduce);
      const mp4FilePathThumb = path.normalize(path.join(fileDir, fileName.replace(/\.[^/.]+$/, '_thumb_output.mp4')));
      const targetTempFilePathThumb = path.join(os.tmpdir(), mp4FilePathThumb);
      await convertFile(tempLocalFile, targetTempFilePathThumb, reduce + '%');
      await bucket.upload(targetTempFilePathThumb, {
        destination: mp4FilePathThumb,
        uploadType: 'media',
        resumable: false,
        public: true,
        metadata: { gzip: true, cacheControl: "public, max-age=31536000" }
      });
      fs.unlinkSync(targetTempFilePathThumb);
    }

    fs.unlinkSync(tempLocalFile);
  }
});

function getCodec(filePath) {
  //console.log("Begin get codec of: " + filePath);
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.log("Error in get codec: " + err);
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

function getDimentions(media) {
  //console.log("Getting Dimentions from:", media);
  return new Promise((res, rej) => {
    ffmpeg.ffprobe(media, (err, metadata) => {
      if (err) {
        console.log("Error occured while getting dimensions of: ", err);
        rej(err);
      }
      res({
        width: metadata.streams[0].width,
        height: metadata.streams[0].height,
      });
    });
  });
}

function convertFile(input, output, size) {
  return new Promise((resolve, reject) => {
    //console.log("Entering converting file: " + size);
    ffmpeg(input)
      .format("mp4")
      .videoCodec("libx264")
      .size(size)
      .on('error', (err) => {
        console.log("Error in converting file: " + err);
        reject(err);
      })
      .on('end', () => {
        //console.log("Success in converting file");
        resolve(output);
      }).saveToFile(output);
  });
}

async function createPoster(bucket, filePath, tempLocalFile) {
  const remotePath = filePath.replace(/\.[^/.]+$/, '_poster.jpg');
  const localPath = path.join(os.tmpdir(), remotePath);
  await createPosterFromVideo(tempLocalFile, localPath);
  await bucket.upload(localPath, {
      destination: remotePath,
      uploadType: 'media',
      resumable: false,
      metadata: { gzip: true, cacheControl: "public, max-age=31536000" }
  });
  fs.unlinkSync(localPath);
}

function createPosterFromVideo(input, output) {
  return new Promise((resolve, reject) => {
      ffmpeg(input)
          .seek(1)
          .frames(1)
          .on('error', (err) => {
              console.log("Error in create poster: " + err);
              reject(err);
          })
          .on('end', () => {
              //console.log("Success in create poster");
              resolve(output);
          })
          .saveToFile(output);
      //DONOT DELETE THIS COMMENT
      // exec('ffmpeg -t 2.5 -i ' + input + ' -filter_complex "[0:v] fps=5,scale=w=480:h=-1,split [a][b];[a] palettegen=stats_mode=single [p];[b][p] paletteuse=new=1" ' + output, (error, stdout) => {
      //     if (error) {
      //         console.log(`error: ${error.message}`);
      //         reject(error);
      //         return;
      //     }
      //     resolve(output);
      //     console.log(`stdout: ${stdout}`);
      // });
  });
}