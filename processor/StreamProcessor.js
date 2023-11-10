import streamBuffers from "stream-buffers";
import StreamingDenoiser from "../Denoiser/denoiser.js";
import { generateUniqueSequenceId } from "../../utils/utils.js";
import { status } from "@grpc/grpc-js";
import {
  concurrentRequests,
  counterTotalRequests,
  isBusy,
} from "../../grafana/metrics.js";

/**
 * Handles audio stream processing.
 */
class StreamProcessor {
  /**
   * Constructs a new StreamProcessor.
   * @param {Stream} stream - The Stream object.
   */
  constructor(stream) {
    this.stream = stream;
    this.sequenceId = generateUniqueSequenceId();
    this.denoiser = new StreamingDenoiser("denoiser_16Khz", this.sequenceId);
    this.firstMessageReceived = false;
    this.intervalDuration = 20;
    this.metadata = {
      uid: this.stream.metadata._internal_repr?.uid?.[0] || "UNK",
      rid: this.stream.metadata._internal_repr?.rid?.[0] || "UNK",
    };
    this.initialize();
  }

  /**
   * Handles a busy server by emitting an error event.
   */
  handleBusyServer() {
    const errorMessage = `UID: ${this.metadata.uid} - RID: ${this.metadata.rid} - ERROR processing request. Server is busy processing a call.`;
    console.error(errorMessage);

    const errorDetails = {
      code: status.INTERNAL,
      message: "Busy instance",
    };

    this.stream.emit("error", errorDetails);
  }

  /**
   * Initializes audio stream processing.
   */
  async initialize() {
    const chunkSize = 640;
    const bufferSize = 100 * 1024;
    const incrementAmount = 10 * 1024;
    const busy = await isBusy();

    if (busy) {
      this.handleBusyServer();
      return;
    }

    concurrentRequests.inc({ denoiser: "request" });
    counterTotalRequests.inc({ denoiser: "request" });

    const myWritableStreamBuffer = new streamBuffers.WritableStreamBuffer({
      initialSize: bufferSize,
      incrementAmount: incrementAmount,
    });

    this.setupStreamEvents(myWritableStreamBuffer, chunkSize);
  }

  /**
   * Sets up event handlers for the stream.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   * @param {number} chunkSize - The size of each audio chunk in bytes.
   */
  setupStreamEvents(buffer, chunkSize) {
    // Handle incoming audio data.
    this.stream.on("data", async (data) => {
      await this.handleIncomingAudio(data, buffer);
    });

    // Process audio at regular intervals.
    this.setupAudioProcessingInterval(buffer, chunkSize);

    // Handle stream close or error events.
    this.setupStreamCloseAndErrorHandler(buffer);
  }

  /**
   * Sets up the interval for processing audio data.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   * @param {number} chunkSize - The size of each audio chunk in bytes.
   */
  setupAudioProcessingInterval(buffer, chunkSize) {
    const writeInterval = setInterval(async () => {
      if (buffer.size() >= chunkSize) {
        const data = buffer.getContents(chunkSize);
        if (data && data.length === chunkSize) {
          const { output_audio_chunk } = await this.denoiser.processAudioChunk(
            data,
            this.sequenceId
          );
          if (output_audio_chunk) {
            this.stream.write({ audio_output: output_audio_chunk });
          }
        }
      }
    }, this.intervalDuration);

    this.writeInterval = writeInterval;
  }

  /**
   * Handles incoming audio messages.
   * @param {Buffer} audio - The audio data.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   */
  async handleIncomingAudio(audio, buffer) {
    try {
      const denoiser = this.denoiser;
      if (!this.firstMessageReceived) {
        this.firstMessageReceived = true;
        const message = await denoiser.start();
        console.log(
          `UID: ${this.metadata.uid} - RID: ${this.metadata.rid} - ${message}`
        );
      } else {
        buffer.write(audio.audio_input);
      }
    } catch (error) {
      console.log(
        `UID: ${this.metadata.uid} - RID: ${this.metadata.rid} - Error in handleIncomingAudio: ${error}`
      );
      await this.stopDenoiserOnError();
    }
  }

  /**
   * Sets up handlers for stream close and error events.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   */
  setupStreamCloseAndErrorHandler(buffer) {
    const closeAndDestroyBuffer = () => {
      buffer.end();
      buffer.destroy();
      clearInterval(this.writeInterval);
      this.stream.end();
      concurrentRequests.dec({ denoiser: "request" });
      this.stopDenoiserOnError();
    };

    // Set up error handler.
    this.stream.on("error", (error) => {
      this.stream.emit("error", { code: status.INTERNAL, message: error });
      closeAndDestroyBuffer();
    });

    // Set up end event handler.
    this.stream.on("end", () => {
      console.log(
        `UID: ${this.metadata.uid} - RID: ${this.metadata.rid} - Stream Ended`
      );
      closeAndDestroyBuffer();
    });
  }

  /**
   * Stops the denoiser and closes it in case of an error.
   */
  async stopDenoiserOnError() {
    try {
      const message = await this.denoiser.stop();
      console.log(
        `UID: ${this.metadata.uid} - RID: ${this.metadata.rid} - ${message}`
      );
      this.denoiser.close();
    } catch (error) {
      console.error(
        `UID: ${this.metadata.uid} - RID: ${this.metadata.rid} - Error in stopDenoiserOnError: ${error}`
      );
    }
  }
}

export default StreamProcessor;
