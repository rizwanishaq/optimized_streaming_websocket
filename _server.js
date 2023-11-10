const { WebSocketServer } = require("ws");
const express = require("express");
const dotenv = require("dotenv");
const colors = require("colors");
const cors = require("cors");
const WebSocketProcessor = require("./processor/WebSocketProcessor.js");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json()); // Enable json parsing
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const server = app.listen(port, () => {
  console.log(`CORS-enables server is listening on port ${port}`.green);
});

// Websocket Server
const wss = new WebSocketServer({ server: server });

console.log("websocket server created".green);
wss.on("connection", (ws, req) => {
  console.log(
    `websocket connection from ${req.connection.remoteAddress}`.red.underline
      .bold
  );

  new WebSocketProcessor(ws);
});
