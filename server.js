'use strict';

const express  = require('express');
const multer   = require('multer');
const tmp      = require('tmp');
const path     = require('path');
const fs       = require('fs');
const { execFile } = require('child_process');

const PORT    = 3456;
const ROOT    = __dirname;
const NODE    = process.execPath;
const CLI     = path.join(ROOT, 'kiri-cli.js');
const DEVICE  = path.join(ROOT, 'device.json');
const PROCESS = path.join(ROOT, 'process.json');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());

app.post('/slice', upload.single('model'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No model file uploaded (field: model)' });
    }

    // Write uploaded STL to a temp file
    tmp.file({ postfix: '.stl', keep: false }, (err, stlPath, _fd, cleanup) => {
        if (err) return res.status(500).json({ error: 'Failed to create temp file' });

        fs.writeFile(stlPath, req.file.buffer, writeErr => {
            if (writeErr) {
                cleanup();
                return res.status(500).json({ error: 'Failed to write STL file' });
            }

            // Build process override from request body
            let processFile = PROCESS;
            let overrides = {};
            if (req.body) {
                if (req.body.layerHeight)    overrides.sliceHeight          = parseFloat(req.body.layerHeight);
                if (req.body.firstLayer)     overrides.firstSliceHeight     = parseFloat(req.body.firstLayer);
                if (req.body.infill)         overrides.sliceFillSparse      = parseFloat(req.body.infill) / 100;
                if (req.body.shells)         overrides.sliceShells          = parseInt(req.body.shells);
                if (req.body.topLayers)      overrides.sliceTopLayers       = parseInt(req.body.topLayers);
                if (req.body.bottomLayers)   overrides.sliceBottomLayers    = parseInt(req.body.bottomLayers);
                if (req.body.printSpeed)     overrides.outputFeedrate       = parseFloat(req.body.printSpeed);
                if (req.body.firstLayerSpeed) overrides.firstLayerRate      = parseFloat(req.body.firstLayerSpeed);
                if (req.body.nozzleTemp)     overrides.outputTemp           = parseFloat(req.body.nozzleTemp);
                if (req.body.bedTemp)        overrides.outputBedTemp        = parseFloat(req.body.bedTemp);
                if (req.body.supports !== undefined) overrides.sliceSupportEnable = req.body.supports === 'true';
                if (req.body.brim !== undefined)     overrides.outputBrimCount    = req.body.brim === 'true' ? 2 : 0;
                if (req.body.brimWidth)      overrides.outputBrimOffset     = parseFloat(req.body.brimWidth);
                if (req.body.retract)        overrides.outputRetractDist    = parseFloat(req.body.retract);
                if (req.body.retractSpeed)   overrides.outputRetractSpeed   = parseFloat(req.body.retractSpeed);
                if (req.body.fanMin)         overrides.firstLayerFanSpeed   = parseInt(req.body.fanMin);
                if (req.body.fanMax)         overrides.outputFanSpeed       = parseInt(req.body.fanMax);
            }

            let processArg = PROCESS;
            if (Object.keys(overrides).length > 0) {
                const base = JSON.parse(fs.readFileSync(PROCESS, 'utf8'));
                const merged = Object.assign({}, base, overrides);
                const tmpProc = tmp.fileSync({ postfix: '.json' });
                fs.writeFileSync(tmpProc.name, JSON.stringify(merged));
                processArg = tmpProc.name;
            }

            let deviceArg = DEVICE;
            let tmpDeviceName = null;
            if (req.body && (req.body.printOriginX !== undefined || req.body.printOriginY !== undefined)) {
                const baseDevice = JSON.parse(fs.readFileSync(DEVICE, 'utf8'));
                const deviceOverride = Object.assign({}, baseDevice);
                const originX = req.body.printOriginX !== undefined
                    ? parseFloat(req.body.printOriginX)
                    : (baseDevice.bedWidth !== undefined ? baseDevice.bedWidth / 2 : 160);
                const originY = req.body.printOriginY !== undefined
                    ? parseFloat(req.body.printOriginY)
                    : (baseDevice.bedDepth !== undefined ? baseDevice.bedDepth / 2 : 160);
                deviceOverride.bedWidth = 2 * originX;
                deviceOverride.bedDepth = 2 * originY;
                const tmpDevice = tmp.fileSync({ postfix: '.json' });
                fs.writeFileSync(tmpDevice.name, JSON.stringify(deviceOverride));
                deviceArg = tmpDevice.name;
                tmpDeviceName = tmpDevice.name;
            }

            const args = [
                CLI,
                `--model=${stlPath}`,
                `--device=${deviceArg}`,
                `--process=${processArg}`,
                '--output=-'
            ];

            execFile(NODE, args, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }, (execErr, stdout, stderr) => {
                cleanup();
                if (processArg !== PROCESS) {
                    try { fs.unlinkSync(processArg); } catch (_) {}
                }
                if (tmpDeviceName) {
                    try { fs.unlinkSync(tmpDeviceName); } catch (_) {}
                }

                if (execErr) {
                    const msg = stderr ? stderr.slice(-500) : execErr.message;
                    return res.status(500).json({ error: msg });
                }

                if (!stdout || stdout.trim().length === 0) {
                    return res.status(500).json({ error: 'Slicer produced no output' });
                }

                res.set('Content-Type', 'text/plain');
                res.send(stdout);
            });
        });
    });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log(`kiri-slicer listening on port ${PORT}`);
});
