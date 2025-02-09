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
        (deviceId & 0x7F),
        0x07, // Sub-ID 1 (File Dump)
        0x01, // Sub-ID 2 (Header)
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

function makeSampleData(seq, data) {
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
    if (data.length > 7) {
        throw "Too much data for bytes";
    }

    let result = [0];

    for (var i = 0; i < data.length; i++) {
        // get the top bit for the i-th byte
        let topBit = (data[i] >> 7) & 0x1;
        result[0] |= (topBit << (6 - i));
        result.push(data[i] & 0x7F);
    }

    return result;
}

function makeFileData(seq, data) {
    if (data.length > 128) {
        throw "Too much data for one file!";
    }

    let sysex = [
        0xF0,
        0x7E,
        (deviceId & 0x7F),
        0x07, // SubID
        0x02, // SubID 2
        seq & 0x7F,
        data.length - 1, // Data length, minus one
    ];

    sysex.push(...encodeFileBytes(data));

    // Checksum
    sysex.push(getChecksum(sysex.slice(1)));
    // EOX
    sysex.push(0xF7);

    return sysex;
}

function chunkFileData(data) {
    
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
    // the total accumulated rollover of packet sequence numbers
    rollover = 0;
    // the sequence number of the last sent packet. incremented on ACK receipt
    seqNum = 0;
    
    onComplete;
    
    constructor(input, output, onComplete, deviceId) {
        this.input = input;
        this.output = output;

        if (this.input) {
            this.input.addEventListener("midimessage", (event) => {
                console.log("MIDIMessage", event);
                if (event.data)
                {
                    console.log("Sample Dump received: ", toHex(event.data));
                }
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
    }

    sendFile(data, type, name) {
        console.log("Sending file!");

        // 1. Chunkify the data
        let totalChunks = Math.ceil(data.length / 128);
        for (var i = 0; i < totalChunks; i++) {
            var chunkLen = 128;
            if ((i + 1) * 128 >= data.length) {
                chunkLen = data.length - (i * 128);
            }
            
            this.chunks.push(new Uint8Array(encodeFileBytes(data.slice(i * 128, i * 128 + chunkLen))));
        }

        console.log("Made chunks:", this.chunks);

        this.seqNum = 0;
        this.rollover = 0;
        
        this.output.send(makeFileHeader(this.deviceId, name, type, data));
    }

    sendSample(data, format, number, rateHz) {
        console.log("Sending sample!");
    }
}