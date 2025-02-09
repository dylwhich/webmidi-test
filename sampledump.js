function makeAck(deviceId, packetId) {
    return [
        0xF0, // SysEx Start
        0x7E, // Non-Realtime
        (deviceId & 0x7F),
        0x7F, // Sub-ID 1 (ACK)
        packetID & 0x7F, // Sub-ID 2 aka packet#
        0xF7, // EOX
    ];
}

function makeNak(deviceId, packetId) {
    return [
        0xF0, // SysEx Start
        0x7E, // Non-Realtime
        (deviceId & 0x7F),
        0x7E, // Sub-ID 1 (NAK)
        packetID & 0x7F, // Sub-ID 2 aka packet#
        0xF7, // EOX
    ]
}

function makeCancel(deviceId) {
    return [
        0xF0,
        0x7E,
        (deviceId & 0x7F),
        0x7D, // Sub-ID 1 (NAK)
        0, // Packet ID (ignored)
        0xF7, // EOX
    ];
}

function makeSampleHeader(deviceId, sampleNum, format, rateHz, sampleCount, data) {
    let rateNs = Math.floor(1000000000 / rateHz);
    return [
        0xF0, // SysEx Start
        0x7E, // Non-Realtime
        (deviceId & 0x7F), // Device ID
        0x01, // Sub-ID 1
        sampleNum & 0x7F, (sampleNum >> 7) & 0x7F, // Sample Number
        format & 0x7F, // Bits-per-ord
        rateNs & 0x7F, (rateNs >> 7) & 0x7F, (rateNs >> 14) & 0x7F, // Inverse sample rate in nanoseconds
        sampleCount & 0x7F, (sampleCount >> 7) & 0x7F, (sampleCount >> 14) & 0x7F, // Total number of samples (words)
        0, 0, 0, // Loop start
        0, 0, 0, // Loop end
        0x7F, // Loop type (Off)
        0xF7, // EOX
    ];
}

function makeFileHeader(deviceId, fileName, fileType, data) {
    let fileLen = data.length;
    // Pad the end of the string with spaces and trim to exactly 4 chars
    let typeData = (fileType + "    ").substring(0, 4);
    
    let sysex = [
        0xF0,
        0x7E,
        0x7F, // deviceId
        0x07, // Sub-ID 1 (File Dump)
        0x01, // Sub-ID 2 (Header)
        (deviceId & 0x7F), // OUR deviceId
        typeData.codePointAt(0) & 0x7F,
        typeData.codePointAt(1) & 0x7F,
        typeData.codePointAt(2) & 0x7F,
        typeData.codePointAt(3) & 0x7F,
        (fileLen & 0x7F),
        (fileLen >> 7) & 0x7F,
        (fileLen >> 14) & 0x7F,
        (fileLen >> 21) & 0x7F,
    ];

    // filename can be as loooong as we want
    for (chr of fileName) {
        sysex.push(chr.codePointAt(0) & 0x7F);
    }
    sysex.push(0xF7); // EOX

    return sysex;
}

function getChecksum(data) {
    let checksum = 0x00;
    for (val of data) {
        checksum ^= (val & 0xFF);
    }
    return checksum;
}

function encodeSampleBytes(data) {
    return data;
}

function makeSampleData(seq, deviceId, data) {
    let sysex = [
        0xF0,
        0x7E,
        (deviceId & 0x7F),
        0x02,
        seq & 0x7F,
        ...data,
    ];

    // Checksum
    sysex.push(getChecksum(sysex.slice(1)));
    // EOX
    sysex.push(0xF7);

    return sysex;
}

function encodeFileBytes(data) {
    let result = [];

    for (var i = 0; i < data.length; i++) {
        if ((i % 7) == 0) {
            result.push(0);
        }
        // get the top bit for the i-th byte
        let topBit = (data[i] >> 7) & 0x1;
        result[Math.floor(i / 7) * 8] |= (topBit << (6 - (i % 7)));
        //console.log("result[%d] |= (%d << (%d) == ", Math.floor(i / 7) * 8, topBit, (6 - (i % 7)), (topBit << (6 - (i & 7))));
        result.push(data[i] & 0x7F);
    }

    console.log("Encoded file data", toHex(data), "into", toHex(result));

    return result;
}

function makeFileData(seq, deviceId, data) {
    if (data.length > 112) {
        console.log("too big!!!!", data.length);
        throw "Too much data for one file data packet: " + (data.length);
    }
    
    let encodedData = encodeFileBytes(data);

    let sysex = [
        0xF0,
        0x7E,
        (deviceId & 0x7F),
        0x07, // SubID
        0x02, // SubID 2
        seq & 0x7F,
        encodedData.length - 1, // Data length, minus one
    ];

    sysex.push(...encodedData);

    // Checksum
    sysex.push(getChecksum(sysex.slice(1)));
    // EOX
    sysex.push(0xF7);

    return sysex;
}

function dataStartsWith(data, prefix) {
    for (var i = 0; i < prefix.length && i < data.length; i++) {
        if (prefix[i] >= 0 && data[i] !== prefix[i]) {
            return false;
        }
    }

    return true;
}

class SampleDump {
    // MIDI inputs/outputs
    input;
    output;

    deviceId = 0x7F;

    // Data chunks received or to-send
    chunks = [];
    isFile = false;
    fileName;
    fileFormat;

    sampleFormat;
    sampleNumber;
    sampleRate;

    expectedPacketCount;
    headerAcked = false;
    // the total accumulated rollover of packet sequence numbers
    rollover = 0;
    // the sequence number of the last sent packet. incremented on ACK receipt
    seqNum = 0;
    retries = 0;
    
    onComplete;
    
    constructor(input, output, onComplete, deviceId) {
        this.input = input;
        this.output = output;

        let self = this;
        if (this.input) {
            this.input.addEventListener("midimessage", (evt) => {
                self.onReceive(evt);
            });
        }

        if (onComplete)
        {
            this.onComplete = onComplete;
        }

        if (typeof deviceId !== 'undefined') {
            this.deviceId = deviceId;
        }
    }

    onReceive(evt) {
        console.log("SampleDump got event", evt);
        console.log("this", this);
        if (evt.data) {
            // negative values can be anything
            const ackMatch = [0xF0, 0x7E, -1, 0x7F];
            const nakMatch = [0xF0, 0x7E, -1, 0x7E];

            if (dataStartsWith(evt.data, ackMatch)) {
                console.log("matched ACK");
                let ackNumber = evt.data[4];
                console.log("ack is for", ackNumber);

                if (ackNumber == this.seqNum) {
                    if (this.headerAcked) {
                        // don't increment the packet number until the header is acked
                        this.retries = 0;
                        this.seqNum++;
                        if (this.seqNum == 128) {
                            this.seqNum = 0;
                            this.rollover += 128;
                        }
                    } else {
                        console.log("acking header");
                        this.headerAcked = true;
                    }
                    this.sendChunkNumber(this.rollover + this.seqNum);

                    if (this.seqNum + this.rollover >= this.expectedPacketCount) {
                        this.onComplete();
                    }
                } else {
                    console.log("ack number (", ackNumber, ") did not match number expected:", this.seqNum);
                }
            }
            else if (dataStartsWith(evt.data, nakMatch)) {
                console.log("matched NAK");
                let nakNumber = evt.data[4];

                this.retries++;

                if (this.retries > 3) {
                    this.send(makeCancel(this.deviceId));
                } else {
                    this.sendChunkNumber(this.rollover + this.seqNum);
                }
            } else {
                console.log("Matched nothing");
            }
        }
    }

    sendChunkNumber(chunkNumber) {
        console.log("sending chunk", chunkNumber);
        if (this.isFile) {
            console.log("isFile");
            if (chunkNumber < this.expectedPacketCount) {
                console.log("packetNumberLess");
                // ok cool
                let packet = makeFileData(this.seqNum, this.deviceId, this.chunks[chunkNumber]);
                this.send(packet);
            }
        }
    }

    sendFile(data, type, name) {
        console.log("Sending file!");

        // 1. Chunkify the data (112 bytes turns into 128 bytes after encoding)
        let totalChunks = Math.ceil(data.length / 112);
        for (var i = 0; i < totalChunks; i++) {
            var chunkLen = 112;
            if ((i + 1) * 112 >= data.length) {
                chunkLen = data.length - (i * 112);
            }
            
            this.chunks.push(new Uint8Array(data.slice(i * 112, i * 112 + chunkLen)));
        }

        console.log("Made chunks:", this.chunks);

        this.seqNum = 0;
        this.rollover = 0;
        this.retries = 0;
        this.headerAcked = false;
        this.isFile = true;
        this.expectedPacketCount = totalChunks;
        
        this.send(makeFileHeader(this.deviceId, name, type, data));
    }

    send(data) {
        console.log("SampleDump sending message:", toHex(data));
        this.output.send(data);
    }

    sendSample(data, format, number, rateHz) {
        console.log("Sending sample!");
    }
}