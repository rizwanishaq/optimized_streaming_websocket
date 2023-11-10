const crypto = require("crypto");
// /**
//  * Converts a buffer to an Int16Array.
//  * @param {Buffer} buffer - The input buffer.
//  * @returns {Int16Array} The resulting Int16Array.
//  */
// const bufferToInt16 = (buffer) => {
//   return new Int16Array(buffer.length / 2).map((val, index) =>
//     buffer.readInt16LE(index * 2)
//   );
// };

/**
 * Converts a buffer to an Int16Array.
 * @param {Buffer} buffer - The input buffer.
 * @returns {Int16Array} The resulting Int16Array.
 */
const bufferToInt16 = (buffer) => {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
};

/**
 * Generates a unique sequence ID.
 * @returns {BigInt} - A unique sequence ID.
 */
const generateUniqueSequenceId = () => {
  const timestamp = BigInt(Date.now() * 1000); // Convert to BigInt directly
  const randomBytes = crypto.randomBytes(4); // Generate 4 random bytes
  const randomNum = BigInt("0x" + randomBytes.toString("hex")); // Convert to BigInt
  return Number(timestamp + randomNum);
};

/**
 * Converts a string to a buffer with a 4-byte length prefix.
 *
 * @param {string} str - The input string.
 * @returns {Buffer} The resulting buffer.
 */
function stringToBuffer(str) {
  // Allocate a 4-byte buffer to store the length of the string
  const lengthBuffer = Buffer.alloc(4);

  // Write the length of the string to the buffer
  lengthBuffer.writeUInt32LE(Buffer.from(str, "utf8").length, 0);

  // Concatenate the length buffer with the buffer from the string
  return Buffer.concat([lengthBuffer, Buffer.from(str, "utf8")]);
}

/**
 * Converts a boolean value to a buffer.
 * @param {boolean} value - The boolean value.
 * @returns {Buffer} The resulting buffer.
 */
function boolToBuffer(value) {
  return Buffer.from([value ? 1 : 0]);
}

/**
 * Converts an integer value to a buffer.
 * @param {number} value - The integer value.
 * @returns {Buffer} The resulting buffer.
 */
function intToBuffer(value) {
  return Buffer.from(new Int32Array([value]).buffer);
}

module.exports = {
  bufferToInt16,
  generateUniqueSequenceId,
  stringToBuffer,
  boolToBuffer,
  intToBuffer,
};
