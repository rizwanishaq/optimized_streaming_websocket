const streamBuffers = require("stream-buffers");
const StreamingASR = require("../services/StreamASR/StreamASR.js");
const { generateUniqueSequenceId } = require("../utils/utils.js");
/**
 * Handles WebSocket connections for audio processing.
 */
class WebSocketProcessor {
  /**
   * Constructs a new WebSocketProcessor.
   * @param {WebSocket} ws - The WebSocket object.
   */
  constructor(ws) {
    /**
     * The WebSocket object.
     * @type {WebSocket}
     */
    this.ws = ws;

    /**
     * A unique sequence ID for the WebSocketProcessor.
     * @type {BigInt}
     */
    this.sequenceId = generateUniqueSequenceId();

    /**
     * The StreamingDenoiser instance for audio processing.
     * @type {StreamingDenoiser}
     */
    this.asr = new StreamingASR("integrator", this.sequenceId);

    /**
     * Indicates if the first message has been received.
     * @type {boolean}
     */
    this.firstMessageReceived = false;

    /**
     * The interval duration for processing audio data.
     * @type {number}
     */
    this.intervalDuration = 20;

    this.initialize();
  }

  /**
   * Initializes WebSocket processing.
   */
  async initialize() {
    const chunkSize = 640; // 640 bytes chunk size
    const bufferSize = 100 * 1024; // 100 kilobytes
    const incrementAmount = 10 * 1024; // 10 kilobytes

    /**
     * Buffer for streaming audio data.
     * @type {streamBuffers.WritableStreamBuffer}
     */
    const myWritableStreamBuffer = new streamBuffers.WritableStreamBuffer({
      initialSize: bufferSize,
      incrementAmount: incrementAmount,
    });

    // Handle incoming audio messages from WebSocket
    this.ws.on("message", async (audio) => {
      await this.handleIncomingAudio(audio, myWritableStreamBuffer);
    });

    // Process audio at regular intervals
    this.setupAudioProcessingInterval(myWritableStreamBuffer, chunkSize);

    // Handle WebSocket close or error events
    this.setupWebSocketCloseAndErrorHandler(myWritableStreamBuffer);
  }

  /**
   * Handles incoming audio messages.
   * @param {Buffer} audio - The audio data.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   */
  async handleIncomingAudio(audio, buffer) {
    try {
      if (!this.firstMessageReceived) {
        this.firstMessageReceived = true;
        const message = await this.asr.start();
        console.log(message);
      } else {
        buffer.write(audio);
      }
    } catch (error) {
      console.error("Error in handleIncomingAudio:", error);
      await this.stopDenoiserOnError();
    }
  }

  /**
   * Sets up the interval for processing audio data.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   * @param {number} chunkSize - The size of each audio chunk.
   */
  setupAudioProcessingInterval(buffer, chunkSize) {
    try {
      const writeInterval = setInterval(async () => {
        if (buffer.size() >= chunkSize) {
          const data = buffer.getContents(chunkSize);
          if (data && data.length === chunkSize) {
            const { transcription, isFinal } = await this.asr.processAudioChunk(
              data,
              this.sequenceId
            );
            if (transcription) {
              this.ws.send(
                JSON.stringify({
                  transcription: transcription,
                  isFinal: isFinal,
                })
              );
            }
          }
        }
      }, this.intervalDuration);

      this.writeInterval = writeInterval; // Store it as a class property for cleanup later
    } catch (error) {
      console.error("Error in setupAudioProcessingInterval:", error);
      this.stopDenoiserOnError();
    }
  }

  /**
   * Sets up handlers for WebSocket close and error events.
   * @param {streamBuffers.WritableStreamBuffer} buffer - The writable stream buffer.
   */
  setupWebSocketCloseAndErrorHandler(buffer) {
    const closeAndDestroyBuffer = async () => {
      const state = this.ws.readyState;
      console.log(
        `WebSocket connection ${
          state === this.ws.CLOSED ? "closed" : "errored"
        }`
      );

      buffer.end();
      buffer.destroy();
      clearInterval(this.writeInterval);

      await this.stopDenoiserOnError();
    };

    this.ws.on("close", closeAndDestroyBuffer);
    this.ws.on("error", closeAndDestroyBuffer);
  }

  /**
   * Stops the denoiser and closes it in case of an error.
   */
  async stopDenoiserOnError() {
    try {
      const message = await this.asr.stop();
      console.log(message);
      this.asr.close();
    } catch (error) {
      console.error("Error in stopDenoiserOnError:", error);
    }
  }
}

module.exports = WebSocketProcessor;
