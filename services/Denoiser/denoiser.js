const grpc = require("@grpc/grpc-js");
const path = require("path");
const protoLoader = require("@grpc/proto-loader");

// Load the gRPC service definition
const packageDefinition = protoLoader.loadSync(
  path.resolve(__dirname, "..", "..", "protocol", "grpc_service.proto"),
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }
);

// Extract the identifier package from the loaded proto
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const identifierPackage = protoDescriptor.inference;

/**
 * Converts a buffer to an Int16Array.
 * @param {Buffer} buffer - The input buffer.
 * @returns {Int16Array} The resulting Int16Array.
 */
const bufferToInt16 = (buffer) => {
  return new Int16Array(buffer.length / 2).map((val, index) =>
    buffer.readInt16LE(index * 2)
  );
};
/**
 * A class for denoising audio streams using Triton.
 */
class StreamingDenoiser {
  /**
   * Initialize the StreamingDenoiser with Triton server connection.
   * @param {string} modelName - Name of the Triton model to use.
   * @param {number} sequenceId - The initial sequence ID.
   */
  constructor(modelName, sequenceId) {
    this.modelName = modelName;
    this.tritonServerHost = process.env.triton_server_host;
    this.tritonServerPort = process.env.triton_server_port;

    // Initialize gRPC client for Triton Inference Server
    try {
      this.client = new identifierPackage.GRPCInferenceService(
        `${this.tritonServerHost}:${this.tritonServerPort}`,
        grpc.credentials.createInsecure()
      );
    } catch (error) {
      console.error(`Error initializing StreamingDenoiser: ${error}`);
      throw error;
    }

    // Create a dummy input for denoising
    this.dummyInput = new Int16Array(320);
    this.sequenceId = sequenceId;
  }

  /**
   * Process an audio chunk for denoising.
   * @param {Int16Array} input_audio_chunk - The input audio chunk for denoising.
   * @returns {Promise<{ output_audio_chunk }>} - A promise that resolves to an object containing the denoised audio chunk.
   * @throws Will reject the promise with an error message if there's an issue with the request.
   */
  processAudioChunk(input_audio_chunk) {
    return new Promise((resolve, reject) => {
      const audio_array = new Int16Array(
        bufferToInt16(input_audio_chunk),
        0,
        input_audio_chunk.length / 2
      );

      const request = {
        model_name: this.modelName,
        inputs: [
          {
            name: "input_audio_chunk",
            datatype: "INT16",
            shape: [audio_array.length],
          },
        ],
        outputs: [{ name: "output_audio_chunk" }],
        raw_input_contents: [Buffer.from(audio_array.buffer)],
        parameters: {
          sequence_id: { int64_param: this.sequenceId },
          sequence_start: { bool_param: false },
          sequence_end: { bool_param: false },
        },
      };

      this.client.ModelInfer(request, (err, response) => {
        if (err) {
          console.error(`Error during request -> ${err}`);
          console.error(`Request Details -> ${JSON.stringify(request)}`);
          this.stop();
          reject(`Error during request -> ${err}`);
          return;
        }

        const output_audio_chunk = response.raw_output_contents[0] || null;

        resolve({ output_audio_chunk });
      });
    });
  }

  /**
   * Start or stop the streaming denoising process.
   * @param {boolean} sequenceStart - Indicates if it's the start of a sequence.
   * @param {boolean} sequenceEnd - Indicates if it's the end of a sequence.
   * @returns {Promise<string>} - A promise that resolves with a message indicating the action.
   * @throws Will reject the promise with an error message if there's an issue with the request.
   */
  startOrStop(sequenceStart, sequenceEnd) {
    return new Promise((resolve, reject) => {
      const request = {
        model_name: this.modelName,
        inputs: [
          {
            name: "input_audio_chunk",
            datatype: "INT16",
            shape: [this.dummyInput.length],
          },
        ],
        outputs: [],
        raw_input_contents: [Buffer.from(this.dummyInput.buffer)],
        parameters: {
          sequence_id: { int64_param: this.sequenceId },
          sequence_start: { bool_param: sequenceStart },
          sequence_end: { bool_param: sequenceEnd },
        },
      };

      this.client.ModelInfer(request, (err, _) => {
        if (err) {
          console.error(
            `Error during ${sequenceStart ? "start" : "stop"} request -> ${err}`
          );
          console.error(`Request Details -> ${JSON.stringify(request)}`);
          reject(
            `Error during ${sequenceStart ? "start" : "stop"} request -> ${err}`
          );
          return;
        }

        const action = sequenceStart ? "started" : "stopped";
        const message = `Stream with sequence_id ${this.sequenceId} ${action}`;

        resolve(message);
      });
    });
  }

  /**
   * Start the streaming denoising process.
   * @returns {Promise<string>} - A promise that resolves with a message indicating the action.
   * @throws Will reject the promise with an error message if there's an issue with the request.
   */
  start() {
    return this.startOrStop(true, false);
  }

  /**
   * Stop the streaming denoising process.
   * @returns {Promise<string>} - A promise that resolves with a message indicating the action.
   * @throws Will reject the promise with an error message if there's an issue with the request.
   */
  stop() {
    return this.startOrStop(false, true);
  }

  /**
   * Close the connection to the Triton server.
   */
  close() {
    if (this.client && !this.client.isClosed) {
      this.client.close();
    }
  }
}

module.exports = StreamingDenoiser;
