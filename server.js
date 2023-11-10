const grpc = require("@grpc/grpc-js");
const path = require("path");
const protoLoader = require("@grpc/proto-loader");
const promClient = require("prom-client");
const express = require("express");
const dotenv = require("dotenv");
const colors = require("colors");
const cors = require("cors");

dotenv.config();

const app = express();
const grpcPort = process.env.grpc_port || 9001;

app.use(express.json()); // Enable json parsing
app.use(express.urlencoded({ extended: false }));
app.use(cors());

// Load the gRPC service definition
const packageDefinition = protoLoader.loadSync(
  path.resolve(__dirname, "protocol", "asr.proto"),
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

const nlpDict = {};
protoDescriptor.utopia.loquista.asr.NLPEncoding.type.value.forEach(
  (x) => (nlpDict[x.name] = x.number)
);

/* - Getting the package name */
const speakerPackage = protoDescriptor.utopia.loquista.asr;

/* - Setting up the grpc server */
const server = new grpc.Server();
server.addService(speakerPackage.Speech.service, {
  /* - Reloads configuration files*/
  Reload: (call, callback) => {
    callback(null, {
      response:
        "Not implemented in Node.js. You need to restart the servers manually.",
    });
  },
  /* - Starts ASR*/
  StreamingRecognize: (stream) => () => {
    console.log();
  },
  /* - Returns server status*/
  GetServerStatus: (call, callback) => {
    callback(null, {});
  },
  /* - Returns server status*/
  ListLanguages: (call, callback) => {
    callback(null, { languages: Object.keys(langconf.language_dict) });
  },
  /* - Returns server status*/
  GetLoad: async (call, callback) => {
    const concReq = await metrics.concurrentRequests.get();
    callback(null, {
      load:
        concReq.values.length > 0
          ? concReq.values.reduce((prev, curr) => prev + curr.value, 0)
          : 0,
    });
  },
});

server.bindAsync(
  `[::]:${grpcPort}`,
  grpc.ServerCredentials.createInsecure(),
  (error) => {
    if (error) {
      console.error(`Error binding gRPC server: ${error}`);
      return;
    }
    console.log(`gRPC server listening on port ${grpcPort}.`);
    server.start();
  }
);
