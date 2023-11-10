const grpc = require("@grpc/grpc-js");
const path = require("path");
const protoLoader = require("@grpc/proto-loader");
const {
  stringToBuffer,
  bufferToInt16,
  boolToBuffer,
  intToBuffer,
} = require("../../utils/utils");

/**
 * Loads the gRPC service definition.
 * @returns {Object} The gRPC service package.
 */
function loadGRPCService() {
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
  return grpc.loadPackageDefinition(packageDefinition).inference;
}

/**
 * A class for denoising audio streams using Triton.
 */
class StreamingASR {
  /**
   * Creates an instance of StreamingASR.
   * @param {string} modelName - Name of the Triton model to use.
   * @param {number} sequenceId - The initial sequence ID.
   */
  constructor(modelName, sequenceId) {
    this.modelName = modelName;
    this.tritonServerHost = process.env.triton_server_host;
    this.tritonServerPort = process.env.triton_server_port;

    // Initialize gRPC client for Triton Inference Server
    this.client = this.initializeGRPCClient();

    // Create a dummy input for denoising
    this.dummyInput = new Int16Array(320);
    this.sequenceId = sequenceId;
    this.useEnhanced = true;
    this.language = "Spanish";
    this.nlpEncoding = 0;
  }

  /**
   * Initializes the gRPC client for Triton Inference Server.
   * @returns {Object} The gRPC client.
   * @throws {Error} If there's an error initializing the client.
   */
  initializeGRPCClient() {
    try {
      return new (loadGRPCService().GRPCInferenceService)(
        `${this.tritonServerHost}:${this.tritonServerPort}`,
        grpc.credentials.createInsecure()
      );
    } catch (error) {
      console.error(`Error initializing StreamingASR: ${error}`);
      throw error;
    }
  }

  /**
   * Processes an audio chunk for denoising.
   * @param {Int16Array} inputAudioChunk - The input audio chunk for denoising.
   * @returns {Promise<{ transcription }>} - A promise resolving to an object with the transcribed audio.
   * @throws {Error} If there's an issue with the request.
   */
  processAudioChunk(inputAudioChunk) {
    return new Promise((resolve, reject) => {
      const audioArray = bufferToInt16(inputAudioChunk);

      const request = {
        model_name: this.modelName,
        inputs: [
          {
            name: "input_audio_chunk",
            datatype: "INT16",
            shape: [audioArray.length],
          },
          { name: "language", datatype: "BYTES", shape: [1] },
          { name: "use_enhanced", datatype: "BOOL", shape: [1] },
          { name: "nlp_encoding", datatype: "INT32", shape: [1] },
        ],
        outputs: [{ name: "transcription" }, { name: "isFinal" }],
        raw_input_contents: [
          Buffer.from(audioArray.buffer),
          stringToBuffer(this.language),
          boolToBuffer(this.useEnhanced),
          intToBuffer(this.nlpEncoding),
        ],
        parameters: { sequence_id: { int64_param: this.sequenceId } },
      };

      this.client.ModelInfer(request, (err, response) => {
        if (err) {
          console.error(`Error during request -> ${err}`);
          console.error(`Request Details -> ${JSON.stringify(request)}`);
          this.stop();
          reject(`Error during request -> ${err}`);
          return;
        }

        const transcription =
          response.raw_output_contents[0]?.toString("utf8", 4) || null;
        const isFinal =
          response.raw_output_contents[1]?.readUInt8(0) === 1
            ? true
            : false || false;

        resolve({ transcription, isFinal });
      });
    });
  }

  /**
   * Starts or stops the streaming denoising process.
   * @param {boolean} sequenceStart - Indicates if it's the start of a sequence.
   * @param {boolean} sequenceEnd - Indicates if it's the end of a sequence.
   * @returns {Promise<string>} - A promise resolving with a message indicating the action.
   * @throws {Error} If there's an issue with the request.
   */
  async startOrStop(sequenceStart, sequenceEnd) {
    const request = {
      model_name: this.modelName,
      inputs: [
        {
          name: "input_audio_chunk",
          datatype: "INT16",
          shape: [this.dummyInput.length],
        },
        { name: "language", datatype: "BYTES", shape: [1] },
        { name: "use_enhanced", datatype: "BOOL", shape: [1] },
        { name: "nlp_encoding", datatype: "INT32", shape: [1] },
      ],
      outputs: [],
      raw_input_contents: [
        Buffer.from(Buffer.from(this.dummyInput.buffer)),
        stringToBuffer(this.language),
        boolToBuffer(this.useEnhanced),
        intToBuffer(this.nlpEncoding),
      ],
      parameters: {
        sequence_id: { int64_param: this.sequenceId },
        sequence_start: { bool_param: sequenceStart },
        sequence_end: { bool_param: sequenceEnd },
      },
    };

    try {
      await this.callModelInfer(request);
      const action = sequenceStart ? "started" : "stopped";
      return `Stream with sequence_id ${this.sequenceId} ${action}`;
    } catch (error) {
      console.error(
        `Error during ${sequenceStart ? "start" : "stop"} request -> ${error}`
      );
      console.error(`Request Details -> ${JSON.stringify(request)}`);
      throw `Error during ${
        sequenceStart ? "start" : "stop"
      } request -> ${error}`;
    }
  }

  /**
   * Starts the streaming denoising process.
   * @returns {Promise<string>} - A promise resolving with a message indicating the action.
   * @throws {Error} If there's an issue with the request.
   */
  start() {
    return this.startOrStop(true, false);
  }

  /**
   * Stops the streaming denoising process.
   * @returns {Promise<string>} - A promise resolving with a message indicating the action.
   * @throws {Error} If there's an issue with the request.
   */
  stop() {
    return this.startOrStop(false, true);
  }

  /**
   * Calls the ModelInfer method.
   * @param {Object} request - The ModelInfer request.
   * @returns {Promise<Object>} - A promise resolving to the ModelInfer response.
   * @throws {Error} If there's an issue with the request.
   */
  callModelInfer(request) {
    return new Promise((resolve, reject) => {
      this.client.ModelInfer(request, (err, response) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Closes the connection to the Triton server.
   */
  close() {
    if (this.client && !this.client.isClosed) {
      this.client.close();
    }
  }
}

module.exports = StreamingASR;
