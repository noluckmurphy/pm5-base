package net.noluck.ergtv

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * Owns the Bluetooth LE link to a Concept2 PM5: scans for it (or reconnects
 * to the one it saw last), subscribes to the multiplexed rowing
 * characteristic, and hands every notification to [onPacket] as raw bytes.
 * Decoding happens in the web page (lib/pm5-ble.js), not here.
 *
 * It keeps retrying until [stop] is called, so the PM5 can be switched on
 * after the app is opened.
 */
@SuppressLint("MissingPermission")
class PM5Link(
    private val context: Context,
    private val onState: (state: String, info: Map<String, String>) -> Unit,
    private val onPacket: (charId: String, bytes: ByteArray) -> Unit,
) {
    companion object {
        private const val TAG = "PM5Link"
        private fun c2(short: String) = UUID.fromString("ce06$short-43e5-11e4-916c-0800200c9a66")
        val DISCOVERY_SERVICE: UUID = c2("0000")
        val ROWING_SERVICE: UUID = c2("0030")
        val MULTIPLEXED: UUID = c2("0080")
        val STATUS_RATE: UUID = c2("0034")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val PREFS = "pm5"
        private const val KEY_ADDR = "lastAddress"
        private const val RETRY_MS = 3000L
        private const val SCAN_MS = 12000L
        // 0 = 1s, 1 = 500ms, 2 = 250ms, 3 = 100ms between status updates
        private const val STATUS_RATE_250MS: Byte = 2
    }

    private val main = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private var running = false
    private var scanning = false
    private var gatt: BluetoothGatt? = null
    private var deviceName: String = ""

    fun start() {
        if (running) return
        running = true
        attempt()
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        stopScan()
        gatt?.let {
            try { it.disconnect() } catch (_: Exception) {}
            try { it.close() } catch (_: Exception) {}
        }
        gatt = null
        report("disconnected")
    }

    val isConnected: Boolean get() = gatt != null && connected
    @Volatile private var connected = false

    private fun report(state: String, extra: Map<String, String> = emptyMap()) {
        main.post { onState(state, extra) }
    }

    private fun attempt() {
        if (!running || gatt != null) return
        val a = adapter
        if (a == null || !a.isEnabled) {
            report("error", mapOf("message" to "Bluetooth is off on the TV"))
            main.postDelayed({ attempt() }, RETRY_MS)
            return
        }
        // Scan every time rather than connecting blind to the saved address:
        // a direct connect to a PM5 that's asleep can block for ~30s.
        startScan()
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            if (!scanning) return
            val saved = prefs.getString(KEY_ADDR, null)
            val dev = result.device
            // Prefer the PM5 we used last time, but take any PM5 if that one
            // isn't around after a few seconds.
            if (saved == null || saved == dev.address || scanElapsed() > 4000) {
                stopScan()
                connect(dev, result.scanRecord?.deviceName ?: dev.name ?: "PM5")
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "scan failed $errorCode")
            scanning = false
            report("error", mapOf("message" to "Bluetooth scan failed ($errorCode)"))
            main.postDelayed({ attempt() }, RETRY_MS)
        }
    }

    private var scanStartedAt = 0L
    private fun scanElapsed() = System.currentTimeMillis() - scanStartedAt

    private fun startScan() {
        val scanner = adapter?.bluetoothLeScanner ?: run {
            main.postDelayed({ attempt() }, RETRY_MS); return
        }
        val filters = listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(DISCOVERY_SERVICE)).build())
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        try {
            scanning = true
            scanStartedAt = System.currentTimeMillis()
            scanner.startScan(filters, settings, scanCallback)
            report("scanning")
            // Restart the scan now and then; some stacks stop reporting after a while.
            main.postDelayed({
                if (scanning) { stopScan(); attempt() }
            }, SCAN_MS)
        } catch (e: Exception) {
            scanning = false
            report("error", mapOf("message" to (e.message ?: "scan error")))
            main.postDelayed({ attempt() }, RETRY_MS)
        }
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
    }

    private fun connect(device: BluetoothDevice, name: String) {
        deviceName = name
        report("connecting", mapOf("name" to name))
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        // Give up on a connect that never completes.
        main.postDelayed({
            if (gatt != null && !connected) {
                Log.w(TAG, "connect timeout")
                drop()
            }
        }, 15000)
    }

    private fun drop() {
        connected = false
        gatt?.let { try { it.close() } catch (_: Exception) {} }
        gatt = null
        report("disconnected")
        if (running) main.postDelayed({ attempt() }, RETRY_MS)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                main.post { g.discoverServices() }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                main.post { if (gatt === g) drop() else try { g.close() } catch (_: Exception) {} }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val ch = g.getService(ROWING_SERVICE)?.getCharacteristic(MULTIPLEXED)
            if (status != BluetoothGatt.GATT_SUCCESS || ch == null) {
                Log.w(TAG, "rowing service missing (status $status)")
                main.post { g.disconnect() }
                return
            }
            g.setCharacteristicNotification(ch, true)
            val d = ch.getDescriptor(CCCD)
            @Suppress("DEPRECATION")
            d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            @Suppress("DEPRECATION")
            g.writeDescriptor(d)
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            // Ask for faster status updates (less lag on the TV). If this
            // write isn't accepted the PM5 just keeps its default rate.
            val rate = g.getService(ROWING_SERVICE)?.getCharacteristic(STATUS_RATE)
            if (rate != null) {
                @Suppress("DEPRECATION")
                rate.value = byteArrayOf(STATUS_RATE_250MS)
                rate.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                if (g.writeCharacteristic(rate)) return
            }
            markConnected(g)
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            markConnected(g)
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val bytes = c.value?.copyOf() ?: return
            onPacket(shortId(c.uuid), bytes)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            onPacket(shortId(c.uuid), value.copyOf())
        }
    }

    private fun markConnected(g: BluetoothGatt) {
        if (connected) return
        connected = true
        prefs.edit().putString(KEY_ADDR, g.device.address).apply()
        report("connected", mapOf("name" to deviceName, "address" to g.device.address))
    }

    private fun shortId(u: UUID) = u.toString().substring(0, 8)
}
