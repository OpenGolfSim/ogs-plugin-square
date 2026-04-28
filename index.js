/// <reference path="plugins.d.ts" />

let bt;

const scope = {
  discoveredCharacteristics: {},
  isScanning: false,
  device: { isConnected: false, isReady: false },
  sequence: 0, // one-byte sequence (%02x)
  lastPayload: null,
  heartBeatInterval: null
};

const COMMAND_CHAR_UUID = '86602101-6b7e-439a-bdd1-489a3213e9bb';
const NOTIFICATION_CHAR_UUID = '86602102-6b7e-439a-bdd1-489a3213e9bb';
const BATTERY_LEVEL_CHAR_UUID = '2a19'; // '00002a19-0000-1000-8000-00805f9b34fb';
const FIRMWARE_VERSION_CHAR_UUID = '86602003-6b7e-439a-bdd1-489a3213e9bb';

const METERS_TO_MPH = 2.23694;

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

  // TODO: Handle swing stick
  // SwingStickCommand: "1182%02x%s0%d0000"
  swingStickCommand: (sequence, swingStickCodeHexString, handedness) => {
    const seq = Commands.padHexByte(sequence);
    const handDigit = String(handedness);
    return '11' + '82' + seq + swingStickCodeHexString + '0' + handDigit + '0000';
  },

  // AlignmentCommand builds 1185... with sequence, confirm byte, and 4 bytes little-endian angleInt
  alignmentCommand: (sequence, confirm, targetAngleFloat) => {
    // angle is int32 of targetAngle * 100
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

function sleep(wait = 1000) {
  return new Promise(resolve => {
    setTimeout(resolve, wait);
  });
}

function bufferToHexList(buffer) {
  return Array.from(buffer).map(b => b.toString(16).padStart(2, '0'));
}


function parseSensorData(buffer) {
  const hexList = bufferToHexList(buffer);
  if (hexList.length < 17) {
    throw new Error('insufficient data for parsing sensor data');
  }

  const sensor = {
    BallReady: hexList[3] === '01' || hexList[3] === '02',
    BallDetected: hexList[4] === '01',
    PositionX: null,
    PositionY: null,
    PositionZ: null,
  };

  try {
    // Position X: bytes 5-8 (little-endian int32)
    sensor.PositionX = buffer.readInt32LE(5);
  } catch (e) { }
  try {
    sensor.PositionY = buffer.readInt32LE(9);
  } catch (e) { }
  try {
    sensor.PositionZ = buffer.readInt32LE(13);
  } catch (e) { }

  return sensor;
}

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
  metrics.SpinAxis = (buffer.readInt16LE(11) / 100.0) * -1;
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
  // Strip optional whitespace or 0x prefix if you want to be lenient
  if (hexStr.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

function bufferToString(arrayBuffer) {
  return String.fromCharCode.apply(null, new Uint8Array(arrayBuffer));
}

async function readBattery() {
  if (!scope.discoveredCharacteristics.battery) {
    throw new Error('Battery characteristic not available');
  }
  const buffer = await scope.discoveredCharacteristics.battery.read();
  logging.info(`Battery`, buffer);
  const view = new DataView(buffer);
  return view.getUint8(0);
}

async function readFirmwareVersion() {
  if (!scope.discoveredCharacteristics.firmware) {
    throw new Error('Firmware characteristic not available');
  }
  const buffer = await scope.discoveredCharacteristics.firmware.read();
  const str = bufferToString(buffer);

  let parsed = null;
  try {
    parsed = JSON.parse(str);
  } catch (e) {
    logging.error(str);
    return;
  }
  return parsed && parsed.lm ? parsed.lm : JSON.stringify(parsed);
}

async function handleNotification(buffer) {
  const hexList = bufferToHexList(buffer);
  const payload = hexList.join(' ');
  try {
    // We detect alignment messages (11 04 ...) and shot messages (11 .. with shot types at offset 2)
    if (hexList[0] === '11' && hexList[1] === '04') {
      const alignment = parseAlignmentData(buffer);
      logging.info('alignment', alignment);
      return;
    }

    if (hexList[0] === '11' && hexList[1] === '01') {
      try {
        const sensor = parseSensorData(buffer);
        logging.info('Parsed sensor data', sensor);
        const sensorIndicatesBall = sensor && (sensor.BallReady && sensor.BallDetected);
        scope.device.isReady = sensorIndicatesBall;
        shotData.updateDeviceStatus(scope.device);
        return;
      } catch (e) {
        // ignore if parse fails
      }
    }
    if (hexList[0] === '11' && hexList[1] === '02') {
      // Parse ball metrics and club metrics when possible
      let ballMetrics = null;
      let clubMetrics = null;
      try {
        ballMetrics = parseShotBallMetrics(buffer);
        logging.info('ballMetrics', ballMetrics);
      } catch (e) { }
      try {
        clubMetrics = parseShotClubMetrics(buffer);
        logging.info('clubMetrics', clubMetrics);
      } catch (e) { }


      // Sanity check that valid ballMetrics are present
      const hasBallMetrics = (
        ballMetrics?.BallSpeedMPS > 0 &&
        ballMetrics?.BallSpeedMPS < 250 &&
        ballMetrics?.TotalspinRPM >= 0 &&
        ballMetrics?.TotalspinRPM < 30_000 &&
        ballMetrics?.VerticalAngle >= 0
      );

      if (hasBallMetrics) {
        if (payload === scope.lastPayload) {
          logging.info(`Payload unchanged`);
          return;
        }
        scope.lastPayload = payload;
        const shot = {
          ballSpeed: ballMetrics.BallSpeedMPS * METERS_TO_MPH,
          verticalLaunchAngle: ballMetrics.VerticalAngle || 0,
          horizontalLaunchAngle: ballMetrics.HorizontalAngle || 0,
          spinSpeed: ballMetrics.TotalspinRPM || 0,
          spinAxis: ballMetrics.SpinAxis || 0
        };
        logging.info(`Sending shot`, shot);

        // TODO: handle clubMetrics (clubMetrics.PathAngle, clubMetrics.FaceAngle, clubMetrics.AttackAngle, clubMetrics.DynamicLoftAngle)
        shotData.sendShot(shot);
        resetAfterShot();

      } else {
        logging.info('Bad shot metrics!');
      }
      return;
    }
    if (hexList[0] === '11' && hexList[1] === '07' && hexList[2] === '0f') {
      // Shot Club Metrics? (format 11 07 0f)
      return;
    }
    if (hexList[0] === '11' && hexList[1] === '10') {
      // OS Version Notification?
      return;
    }
  } catch (err) {
    logging.error('error', err);
  }

}

async function resetAfterShot() {
  scope.device.isReady = false;
  shotData.updateDeviceStatus(scope.device);
  await sleep(3000);
  logging.info('Setting device ready after shot...');
  sendReady();
}

async function setupNotifications() {
  return new Promise((resolve, reject) => {
    const subPromises = [];

    if (scope.discoveredCharacteristics.event) {
      scope.discoveredCharacteristics.event.on('data', (data, isNotification) => {
        try {
          if (!data.buffer) return;
          handleNotification(Buffer.from(data.buffer));
        } catch (err) {
          logging.error('Event error', e);
        }
      });
      subPromises.push(scope.discoveredCharacteristics.event.subscribe());
    }

    if (scope.discoveredCharacteristics.battery) {
      // subscribe to battery notifications if possible
      scope.discoveredCharacteristics.battery.on('data', (data, isNotification) => {
        try {
          if (!data.buffer) return;
          const level = Buffer.from(data.buffer).readUInt8(0);
          scope.device.batteryLevel = level;
          shotData.updateDeviceStatus(scope.device);
        } catch (e) {
          logging.error('Battery error', e);
        }
      });
      subPromises.push(
        scope.discoveredCharacteristics.battery.subscribe()
      );
    }

    Promise.all(subPromises)
      .then(() => resolve())
      .catch(err => reject(err));
  });
}

function nextSequence() {
  const s = scope.sequence & 0xff;
  scope.sequence = (scope.sequence + 1) & 0xff;
  return s;
}

function writeCommandBuffer(buffer) {
  if (!scope.discoveredCharacteristics.command) {
    throw new Error('Command characteristic not available');
  }
  // We choose withoutResponse=false for safer writes when we want confirmation,
  // but many devices accept withoutResponse=true
  const withoutResponse = false;
  scope.discoveredCharacteristics.command.write(buffer);
}

function sendDetectBall(mode = 1, spinMode = 0) {
  const seq = nextSequence();
  const hex = Commands.detectBall(seq, mode, spinMode);
  return writeCommandBuffer(hexToBuffer(hex));
}

// select a club by regular code (use constants in repo for club codes)
function sendSelectClub(clubRegularCodeHexString, handedness = 0) {
  const seq = nextSequence();
  const hex = Commands.clubCommand(seq, clubRegularCodeHexString, handedness);
  return writeCommandBuffer(hexToBuffer(hex));
}

function sendHeartbeat() {
  const seq = nextSequence();
  const hex = Commands.heartbeat(seq);
  return writeCommandBuffer(hexToBuffer(hex));
}

// "ready" in the UI maps to enabling ball detection; map to DetectBallCommand with Activate
function sendReady() {
  // mode=1 (Activate), spinMode=0 (Standard) by default
  return sendDetectBall(1, 1);
}

async function initializeDevice() {
  logging.info('Reading battery level');
  const b = await readBattery();
  logging.info(`   batteryLevel: ${b}`);
  const fw = await readFirmwareVersion();
  logging.info(`       firmware: ${fw}`);

  scope.device.isConnected = true;
  scope.device.batteryLevel = b;
  scope.device.firmware = fw;
  shotData.updateDeviceStatus(scope.device);

  await setupNotifications();

  await sendHeartbeat();

  await sleep(2000);

  logging.info(`Selecting driver...`);
  await sendSelectClub(SQUARE_CLUBS.DRIVER.code, 0);

  // we simply wait 3 seconds and send the fist ready event
  // TODO: we should make this more aware of the simulator game state
  await sleep(3000);
  logging.info(`Sending ready event...`);
  await sendReady();

  scope.heartBeatInterval = setInterval(sendHeartbeat, 5000);
}

async function connectToDevice(peripheral) {
  
  scope.peripheral = peripheral;
  await cancelScan();
  
  peripheral.on('disconnect', () => {
    clearInterval(scope.heartBeatInterval);
    logging.info('peripheral disconnected');
    scope.discoveredCharacteristics = {};
    scope.peripheral = null;
    scope.device = { isConnected: false, isReady: false };
    shotData.updateDeviceStatus(scope.device);
  });

  peripheral.on('error', (error) => {
    logging.info('peripheral error', error);
  });

  await peripheral.connect();
  logging.info('Connected to Square LM!');
  logging.info('Discovering services...');

  const { characteristics } = await peripheral.discoverAllServicesAndCharacteristics();

  const findChar = uuid => {
    const normalized = (uuid || '').replace(/-/g, '').toLowerCase();
    return characteristics.find(c => (c.uuid || '').toLowerCase() === normalized);
  };

  scope.discoveredCharacteristics.command = findChar(COMMAND_CHAR_UUID);
  scope.discoveredCharacteristics.event = findChar(NOTIFICATION_CHAR_UUID);
  scope.discoveredCharacteristics.battery = findChar(BATTERY_LEVEL_CHAR_UUID);
  scope.discoveredCharacteristics.firmware = findChar(FIRMWARE_VERSION_CHAR_UUID);

  logging.info('chars discovered:', {
    command: !!scope.discoveredCharacteristics.command,
    event: !!scope.discoveredCharacteristics.event,
    battery: !!scope.discoveredCharacteristics.battery,
    firmware: !!scope.discoveredCharacteristics.firmware,
  });

  await initializeDevice();
}

async function handleDiscoveredDevice(device) {
  try {
    // when plugin.requiresPairing is set to "bluetooth" in the plugin's package.json, OGS will handle initial scan + pairing
    // and bluetoothAddress will be the user-selected bluetooth device ID
    if (device.id === preferences.launchMonitor?.bluetoothAddress) {
      logging.info(`Found a square golf device: (id:${device.id},name:${device.advertisement?.localName})`);
      connectToDevice(device);
    }
    // We fallback to name based matching some square devices advertise as BlueZ or Square
    // Most windows bluetooth drivers don't contain a BLE localName, so this approach often fails
    // The pairing and ID matches on windows (uses MAC address), but the localName is usually empty
    // While on macOS, the name matches but the ID doesn't
    else if (/bluez|square/i.test(device.advertisement?.localName || '')) {
      logging.info(`Found a square golf device: (id:${device.id},name:${device.advertisement?.localName})`);
      connectToDevice(device);
    }
  } catch (error) {
    logging.error('Unable to scan for device!');
    cancelScan();
  }

}

async function cancelScan() {
  bt.off('discover', handleDiscoveredDevice);
  await bt.stopScanning();
  scope.isScanning = false;
}

system.on('exit', async () => {
  logging.info('Exiting ogs-plugin-square...');
  if (scope.peripheral) {
    await scope.peripheral.disconnect();
  }
  await cancelScan();
});

(async () => {
  try {
    logging.info('Starting ogs-plugin-square...');
    // Scan and connect
    bt = bluetooth.createClient();
    bt.on('discover', handleDiscoveredDevice);
    
    logging.info('Waiting for powered on!');
    await bt.waitForPoweredOn();
    await bt.startScanning();
    scope.isScanning = true;

  } catch (error) {
    logging.error('Plugin Error', error);
  }
})();


