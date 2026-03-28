/// <reference path="plugins.d.ts" />

let bt;

const scope = {
  discoveredCharacteristics: {},
  isScanning: false,
  device: { isConnected: false, isReady: false }
};

const SQUARE_CLUBS = {

  PUTTER: { id: 'PT', code: '0107', swingStickCode: '0103' },
  DRIVER: { id: 'DR', code: '0204', swingStickCode: '0202' },

  // Woods
  WOOD3: {  id: '3W', code: '0305', swingStickCode: '0301' },
  WOOD5: { id: '5W', code: '0505', swingStickCode: '0501' },
  WOOD7: { id: '7W', code: '0705', swingStickCode: '0701' },

  // Irons
  IRON4: { id: '4I', alias: ['3I'], code: '0406', swingStickCode: '0400' },
  IRON5: { id: '5I', code: '0506', swingStickCode: '0500' },
  IRON6: { id: '6I', code: '0606', swingStickCode: '0600' },
  IRON7: { id: '7I', code: '0706', swingStickCode: '0700' },
  IRON8: { id: '8I', code: '0806', swingStickCode: '0900' },
  IRON9: { id: '9I', code: '0906', swingStickCode: '0900' },

  // Wedges
  WEDGE_PITCHING: { id: 'PW', code: '0a06', swingStickCode: '0a00' },
  WEDGE_APPROACH: { id: 'LW', code: '0b06', swingStickCode: '0b00' },
  WEDGE_SAND: { id: 'SW', code: '0c06', swingStickCode: '0c00' },

  // Alignment stick - special club type used to activate alignment mode
  ALIGNMENT_STICK: { code: '0008', swingStickCode: '0008' }

};

const Commands = {
  padHexByte: (n) => {
    const h = n & 0xff;
    return h.toString(16).padStart(2, '0');
  },

  // Heartbeat: "1183%02x0000000000"
  heartbeat: (sequence) => {
    return '11' + '83' + Commands.padHexByte(sequence) + '0000000000';
  },

  // DetectBallCommand: "1181%02x0%d1%d00000000"
  // mode: DetectBallMode (0=deactivate,1=activate,2=activate alignment)
  // spinMode: SpinMode (0=standard,1=advanced)
  detectBall: (sequence, mode, spinMode) => {
    // Format: 11 81 {seq} 0{mode} 1{spinMode} 00 00 00 00
    // We will format exactly like Go: "1181%02x0%d1%d00000000"
    const seq = Commands.padHexByte(sequence);
    const modeDigit = String(mode);
    const spinDigit = String(spinMode);
    return '11' + '81' + seq + '0' + modeDigit + '1' + spinDigit + '00000000';
  },

  // ClubCommand: "1182%02x%s0%d000000"
  // clubCode: club.RegularCode (string two bytes per nibble)
  clubCommand: (sequence, clubRegularCodeHexString, handedness) => {
    // clubRegularCodeHexString expected like "0107" (4 hex chars) -> inserted directly
    const seq = Commands.padHexByte(sequence);
    const handDigit = String(handedness);
    return '11' + '82' + seq + clubRegularCodeHexString + '0' + handDigit + '000000';
  },

  // SwingStickCommand: "1182%02x%s0%d0000" (uses SwingStickCode)
  swingStickCommand: (sequence, swingStickCodeHexString, handedness) => {
    const seq = Commands.padHexByte(sequence);
    const handDigit = String(handedness);
    return '11' + '82' + seq + swingStickCodeHexString + '0' + handDigit + '0000';
  },

  // AlignmentCommand builds 1185... with sequence, confirm byte, and 4 bytes little-endian angleInt
  alignmentCommand: (sequence, confirm, targetAngleFloat) => {
    // angle is int32 of targetAngle * 100 (per Go)
    const angleInt = Math.floor(targetAngleFloat * 100) | 0; // int32
    // Split into little-endian bytes
    const b0 = (angleInt & 0xff) >>> 0;
    const b1 = ((angleInt >> 8) & 0xff) >>> 0;
    const b2 = ((angleInt >> 16) & 0xff) >>> 0;
    const b3 = ((angleInt >> 24) & 0xff) >>> 0;
    const seq = Commands.padHexByte(sequence);
    const confirmByte = Commands.padHexByte(confirm);
    return (
      '11' +
      '85' +
      seq +
      confirmByte +
      Commands.padHexByte(b0) +
      Commands.padHexByte(b1) +
      Commands.padHexByte(b2) +
      Commands.padHexByte(b3)
    );
  },

  startAlignment: (sequence) => {
    return Commands.alignmentCommand(sequence, 0, 0.0);
  },

  stopAlignment: (sequence, targetAngle) => {
    return Commands.alignmentCommand(sequence, 1, targetAngle);
  },

  cancelAlignment: (sequence, targetAngle) => {
    return Commands.alignmentCommand(sequence, 0, targetAngle);
  },

  // RequestClubMetrics: "1187%02x000000000000"
  requestClubMetrics: (sequence) => {
    const seq = Commands.padHexByte(sequence);
    return '11' + '87' + seq + '000000000000';
  },

  // GetOSVersionCommand: "1192%02x0000000000"
  getOSVersion: (sequence) => {
    const seq = Commands.padHexByte(sequence);
    return '11' + '92' + seq + '0000000000';
  }
};


function parseShotBallMetrics(buffer) {
  const hexList = bufferToHexList(buffer);
  if (hexList.length < 17) {
    throw new Error('insufficient data for parsing ball metrics');
  }

  const metrics = {
    // RawData: hexList,
    BallSpeedMPS: null,
    VerticalAngle: null,
    HorizontalAngle: null,
    TotalspinRPM: null,
    SpinAxis: null,
    BackspinRPM: null,
    SidespinRPM: null,
    ShotType: null,
  };

  // Determine shot type from header (byte index 2)
  if (hexList.length >= 3) {
    if (hexList[2] === '37') {
      metrics.ShotType = 'full';
    } else if (hexList[2] === '13') {
      metrics.ShotType = 'putt';
    }
  }

  metrics.BallSpeedMPS = buffer.readInt16LE(3) / 100.0;
  metrics.VerticalAngle = buffer.readInt16LE(5) / 100.0;
  metrics.HorizontalAngle = buffer.readInt16LE(7) / 100.0;
  metrics.TotalspinRPM = buffer.readInt16LE(9);
  metrics.SpinAxis = buffer.readInt16LE(11) / 100.0;
  metrics.BackspinRPM = buffer.readInt16LE(13);
  metrics.SidespinRPM = buffer.readInt16LE(15);

  return metrics;
}

function parseShotClubMetrics(buffer) {
  const hexList = bufferToHexList(buffer);
  if (hexList.length < 11) {
    throw new Error('insufficient data for parsing club metrics');
  }

  const metrics = {
    // RawData: hexList,
    PathAngle: null,
    FaceAngle: null,
    AttackAngle: null,
    DynamicLoftAngle: null,
  };

  try {
    metrics.PathAngle = buffer.readInt16LE(3) / 100.0;
  } catch (e) { }
  try {
    metrics.FaceAngle = buffer.readInt16LE(5) / 100.0;
  } catch (e) { }
  try {
    metrics.AttackAngle = buffer.readInt16LE(7) / 100.0;
  } catch (e) { }
  try {
    metrics.DynamicLoftAngle = buffer.readInt16LE(9) / 100.0;
  } catch (e) { }

  return metrics;
}

function parseAlignmentData(buffer) {
  const hexList = bufferToHexList(buffer);
  if (hexList.length < 7) {
    throw new Error('insufficient data for parsing alignment data');
  }
  const alignment = {
    // RawData: hexList,
    AimAngle: null,
    IsAligned: null,
  };

  try {
    const angleRaw = buffer.readInt16LE(5);
    alignment.AimAngle = angleRaw / 100.0;
  } catch (e) { }

  const alignmentThreshold = 2.0;
  alignment.IsAligned =
    alignment.AimAngle !== null &&
    alignment.AimAngle >= -alignmentThreshold &&
    alignment.AimAngle <= alignmentThreshold;

  return alignment;
}

function hexToBuffer(hexStr) {
  if (!hexStr) return Buffer.alloc(0);
  // remove any non-hex chars just in case
  const cleaned = ('' + hexStr).replace(/[^a-f0-9]/gi, '').toLowerCase();
  return Buffer.from(cleaned, 'hex');
}

async function connectToDevice(device) {

  device.on('disconnect', () => {
    console.log('peripheral disconnected');
    clearInterval(heartBeatTimer);
    discoveredCharacteristics = {};
    scope.device = { isConnected: false, isReady: false };
    shotData.updateDeviceStatus(scope.device);
    this.emit('device', this.device);
  });

  device.on('error', (error) => {
    logging.debug('peripheral error', error);
  });

  await device.connectAsync();
  logging.info('Connected to Square LM!');
  logging.debug('Discovering services...');

  const { characteristics } = await device.discoverAllServicesAndCharacteristicsAsync();

  const findChar = uuid => {
    const normalized = (uuid || '').replace(/-/g, '').toLowerCase();
    return characteristics.find(c => (c.uuid || '').toLowerCase() === normalized);
  };

  discoveredCharacteristics.command = findChar(COMMAND_CHAR_UUID);
  discoveredCharacteristics.event = findChar(NOTIFICATION_CHAR_UUID);
  discoveredCharacteristics.battery = findChar(BATTERY_LEVEL_CHAR_UUID);
  discoveredCharacteristics.firmware = findChar(FIRMWARE_VERSION_CHAR_UUID);

  scope.device.isConnected = true;
  shotData.updateDeviceStatus(scope.device);
}

async function handleDiscoveredDevice(device) {
  try {
    logging.info(`Discovered device: (id:${device.id},name:${device.advertisement?.localName})`, JSON.stringify(device));
  
    // some square devices advertise as BlueZ
    const nameMatch = /bluez|square/i.test(device.advertisement.localName || '');
    
    // The ID matches on windows (uses MAC address), but the localName is usually empty
    // While on macOS, the name matches on both sides but the ID doesn't. 
    // So we allow either to match
    if (nameMatch) {
      logging.info('Found a square golf device!');
      // connecting
      scope.isScanning = false;
      await bt.stopScanning();
      connectToDevice(device);
    }
  } catch (error) {
    logging.error('Unable to scan for device!');
  }

}

system.on('exit', async () => {
  logging.info('EXIT PLUGIN!');
  bt.off('discover', handleDiscoveredDevice);
  if (scope.isScanning) {
    await bt.stopScanning();
    scope.isScanning = false;
  }
  logging.info('PLUGIN STOPPED!');
});

(async () => {
  try {
    logging.info('Starting ogs-plugin-square!');
    // Scan and connect
    bt = bluetooth.createClient();
    bt.on('discover', handleDiscoveredDevice);
    
    logging.info('Waiting for powered on!');
    await bt.waitForPoweredOn();
    await bt.startScanning();
    scope.isScanning = true;
  } catch (error) {
    logging.error('Square Error', error);
  }
})();


