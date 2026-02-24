package com.codex.mobile

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Manages the lifecycle of the Node.js codex-web-local server process running
 * inside the Termux bootstrap environment. Handles installation of Node.js,
 * Codex CLI, the platform-specific native binary, authentication via
 * `codex login`, and the codex-web-local web server.
 */
class CodexServerManager(private val context: Context) {

    companion object {
        private const val TAG = "CodexServerManager"
        const val SERVER_PORT = 18923
        private const val PROXY_PORT = 18924
        private const val CODEX_VERSION = "0.104.0"
        const val PI_GATEWAY_PORT = 18789
        const val PI_CONTROL_UI_PORT = 19001
    }

    private var serverProcess: Process? = null
    private var proxyProcess: Process? = null
    private var piGatewayProcess: Process? = null
    private var piControlUiProcess: Process? = null

    val isRunning: Boolean
        get() {
            val proc = serverProcess ?: return false
            return try {
                proc.exitValue()
                false
            } catch (_: IllegalThreadStateException) {
                true
            }
        }

    // ── Shell helpers ──────────────────────────────────────────────────────

    /**
     * Run a shell command inside the Termux prefix environment.
     * Returns the exit code.
     */
    fun runInPrefix(
        command: String,
        onOutput: ((String) -> Unit)? = null,
    ): Int {
        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths)

        val shell = "${paths.prefixDir}/bin/sh"
        val pb = ProcessBuilder(shell, "-c", command)
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        val reader = BufferedReader(InputStreamReader(proc.inputStream))
        var line = reader.readLine()
        while (line != null) {
            Log.d(TAG, line)
            onOutput?.invoke(line)
            line = reader.readLine()
        }
        return proc.waitFor()
    }

    /**
     * Run a command and capture its stdout as a single trimmed string.
     */
    private fun runCapture(command: String): String {
        val sb = StringBuilder()
        runInPrefix(command) { sb.appendLine(it) }
        return sb.toString().trim()
    }

    // ── Install checks ─────────────────────────────────────────────────────

    fun isProotInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.prefixDir, "bin/proot").exists()
    }

    fun isNodeInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.prefixDir, "bin/node").exists()
    }

    fun isCodexInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.prefixDir, "lib/node_modules/@openai/codex/bin/codex.js").exists()
    }

    fun isServerBundleInstalled(): Boolean = false

    /**
     * The native Rust binary that the JS launcher delegates to.
     * Required for `codex app-server`, `codex login`, `codex exec`, etc.
     */
    fun isPlatformBinaryInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(
            paths.prefixDir,
            "lib/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/codex/codex",
        ).exists()
    }

    // ── Installation ────────────────────────────────────────────────────────

    fun installNode(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir

        onProgress("Downloading Node.js packages…")

        val downloadCmd = """
            cd $prefix/tmp &&
            apt-get update --allow-insecure-repositories 2>&1;
            apt-get download --allow-unauthenticated c-ares libicu libsqlite nodejs-lts npm 2>&1
        """.trimIndent()

        val dlCode = runInPrefix(downloadCmd, onOutput = { onProgress(it) })
        if (dlCode != 0) {
            Log.e(TAG, "apt-get download failed with code $dlCode")
        }

        onProgress("Extracting Node.js packages…")
        val termuxPrefix = "/data/data/com.termux/files/usr"
        val extractCmd = """
            cd $prefix/tmp &&
            mkdir -p _stage &&
            for deb in *.deb; do
                echo "Extracting ${'$'}deb..." &&
                dpkg-deb -x "${'$'}deb" _stage/ 2>&1
            done &&
            if [ -d "_stage$termuxPrefix" ]; then
                cp -a _stage$termuxPrefix/* "$prefix/" 2>&1
            elif [ -d "_stage/usr" ]; then
                cp -a _stage/usr/* "$prefix/" 2>&1
            fi &&
            rm -rf _stage *.deb 2>/dev/null
            echo "done"
        """.trimIndent()

        val extractCode = runInPrefix(extractCmd, onOutput = { onProgress(it) })
        if (extractCode != 0) {
            Log.e(TAG, "dpkg-deb extract failed with code $extractCode")
            return false
        }

        onProgress("Fixing script paths…")
        val fixCmd = """
            chmod 700 "$prefix/bin/node" 2>/dev/null

            CODEX_JS="$prefix/lib/node_modules/@openai/codex/bin/codex.js"
            if [ -f "${'$'}CODEX_JS" ]; then
                rm -f "$prefix/bin/codex"
                cat > "$prefix/bin/codex" << 'WEOF'
#!/data/user/0/com.codex.mobile/files/usr/bin/sh
exec /data/user/0/com.codex.mobile/files/usr/bin/node /data/user/0/com.codex.mobile/files/usr/lib/node_modules/@openai/codex/bin/codex.js "${'$'}@"
WEOF
                chmod 700 "$prefix/bin/codex"
            fi

            NPM_CLI="$prefix/lib/node_modules/npm/bin/npm-cli.js"
            if [ -f "${'$'}NPM_CLI" ]; then
                rm -f "$prefix/bin/npm"
                cat > "$prefix/bin/npm" << 'WEOF'
#!/data/user/0/com.codex.mobile/files/usr/bin/sh
exec /data/user/0/com.codex.mobile/files/usr/bin/node /data/user/0/com.codex.mobile/files/usr/lib/node_modules/npm/bin/npm-cli.js "${'$'}@"
WEOF
                chmod 700 "$prefix/bin/npm"
            fi

            echo "Wrapper scripts created"
        """.trimIndent()
        runInPrefix(fixCmd, onOutput = { onProgress(it) })

        return isNodeInstalled()
    }

    /**
     * Install proot from the Termux repository. proot uses ptrace to
     * intercept filesystem syscalls and remap hardcoded Termux paths
     * (e.g. /data/data/com.termux/files/usr) to our actual prefix,
     * enabling dpkg, apt-get install, and other tools that have
     * compiled-in path references.
     */
    fun installProot(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val termuxPrefix = "/data/data/com.termux/files/usr"

        onProgress("Downloading proot…")

        val downloadCmd = """
            cd $prefix/tmp &&
            apt-get update --allow-insecure-repositories 2>&1;
            apt-get download --allow-unauthenticated proot libtalloc 2>&1
        """.trimIndent()

        val dlCode = runInPrefix(downloadCmd, onOutput = { onProgress(it) })
        if (dlCode != 0) {
            Log.e(TAG, "apt-get download proot failed with code $dlCode")
            return false
        }

        onProgress("Extracting proot…")
        val extractCmd = """
            cd $prefix/tmp &&
            mkdir -p _proot_stage &&
            for deb in proot*.deb libtalloc*.deb; do
                [ -f "${'$'}deb" ] && dpkg-deb -x "${'$'}deb" _proot_stage/ 2>&1
            done &&
            if [ -d "_proot_stage$termuxPrefix" ]; then
                cp -a _proot_stage$termuxPrefix/* "$prefix/" 2>&1
            elif [ -d "_proot_stage/usr" ]; then
                cp -a _proot_stage/usr/* "$prefix/" 2>&1
            fi &&
            chmod 700 "$prefix/bin/proot" 2>/dev/null
            rm -rf _proot_stage proot*.deb libtalloc*.deb 2>/dev/null
            echo "proot installed"
        """.trimIndent()

        val extractCode = runInPrefix(extractCmd, onOutput = { onProgress(it) })
        if (extractCode != 0) {
            Log.e(TAG, "proot extract failed with code $extractCode")
            return false
        }

        return isProotInstalled()
    }

    fun isPythonInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.prefixDir, "bin/python3").exists() ||
            File(paths.prefixDir, "bin/python").exists()
    }

    /**
     * Install Python using proot to handle dpkg's hardcoded Termux paths.
     * proot bind-mounts our prefix onto the compiled-in Termux prefix so
     * dpkg postinst scripts and shared library lookups resolve correctly.
     */
    fun installPython(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val termuxPrefix = "/data/data/com.termux/files/usr"

        onProgress("Downloading Python packages…")

        val downloadCmd = """
            cd $prefix/tmp &&
            apt-get update --allow-insecure-repositories 2>&1;
            apt-get download --allow-unauthenticated python python-pip 2>&1
        """.trimIndent()

        val dlCode = runInPrefix(downloadCmd, onOutput = { onProgress(it) })
        if (dlCode != 0) {
            Log.e(TAG, "apt-get download python failed with code $dlCode")
        }

        onProgress("Extracting Python…")
        val extractCmd = """
            cd $prefix/tmp &&
            mkdir -p _python_stage &&
            for deb in python*.deb; do
                [ -f "${'$'}deb" ] && echo "Extracting ${'$'}deb..." && dpkg-deb -x "${'$'}deb" _python_stage/ 2>&1
            done &&
            if [ -d "_python_stage$termuxPrefix" ]; then
                cp -a _python_stage$termuxPrefix/* "$prefix/" 2>&1
            elif [ -d "_python_stage/usr" ]; then
                cp -a _python_stage/usr/* "$prefix/" 2>&1
            fi &&
            chmod 700 "$prefix/bin/python"* 2>/dev/null
            chmod 700 "$prefix/bin/pip"* 2>/dev/null
            rm -rf _python_stage python*.deb 2>/dev/null
            echo "Python installed"
        """.trimIndent()

        val extractCode = runInPrefix(extractCmd, onOutput = { onProgress(it) })
        if (extractCode != 0) {
            Log.e(TAG, "Python extract failed with code $extractCode")
            return false
        }

        // Create python3 wrapper to handle shebang issues
        val fixCmd = """
            if [ -f "$prefix/bin/python3" ] && [ ! -f "$prefix/bin/python" ]; then
                ln -sf python3 "$prefix/bin/python"
            fi
            echo "Python ready"
        """.trimIndent()
        runInPrefix(fixCmd, onOutput = { onProgress(it) })

        return isPythonInstalled()
    }

    /**
     * Install bionic-compat.js from APK assets into the home directory.
     * This shim patches process.platform, os.cpus(), and
     * os.networkInterfaces() for Android compatibility.
     * Loaded via NODE_OPTIONS="-r <path>/bionic-compat.js".
     */
    fun ensureBionicCompat() {
        val paths = BootstrapInstaller.getPaths(context)
        val patchDir = File(paths.homeDir, ".anyclaw/patches")
        patchDir.mkdirs()

        val target = File(patchDir, "bionic-compat.js")
        try {
            context.assets.open("bionic-compat.js").use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
            Log.i(TAG, "bionic-compat.js installed to $target")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to extract bionic-compat.js: ${e.message}")
        }
    }

    // ── Pi Runtime (pi_agent_rust core + zeroclaw compatibility) ───────────

    fun isPiCoreInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefixBin = File(paths.prefixDir, "bin/pi")
        val localBin = File(paths.homeDir, ".local/bin/pi")
        if (prefixBin.exists() || localBin.exists()) return true
        return runInPrefix("command -v pi >/dev/null 2>&1") == 0
    }

    fun isZeroClawCompatInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.prefixDir, "bin/zeroclaw").exists()
    }

    /**
     * Install pi_agent_rust as canonical core runtime.
     * Uses upstream installer script and falls back to source build.
     */
    fun installPiCore(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir

        val cmd = """
            export PATH="$prefix/bin:${'$'}HOME/.local/bin:${'$'}PATH" &&
            if command -v pi >/dev/null 2>&1; then
              echo "pi core already installed";
              exit 0;
            fi &&
            if ! command -v curl >/dev/null 2>&1; then
              echo "curl is required to install pi_agent_rust";
              exit 1;
            fi &&
            (
              curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/pi_agent_rust/main/install.sh" \
                | bash -s -- --yes --no-agent-skills --no-completions 2>&1
            ) || (
              echo "binary install failed; retrying with source build" &&
              curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/pi_agent_rust/main/install.sh" \
                | bash -s -- --yes --from-source --no-agent-skills --no-completions 2>&1
            ) &&
            mkdir -p "$prefix/bin" &&
            if [ -x "${'$'}HOME/.local/bin/pi" ]; then
              ln -sf "${'$'}HOME/.local/bin/pi" "$prefix/bin/pi";
            fi &&
            command -v pi >/dev/null 2>&1 &&
            pi --version 2>&1
        """.trimIndent()

        onProgress("Installing pi_agent_rust core…")
        val code = runInPrefix(cmd, onOutput = { onProgress(it) })
        if (code != 0) {
            Log.e(TAG, "pi_agent_rust install failed with code $code")
            return false
        }
        return isPiCoreInstalled()
    }

    /**
     * Install zeroclaw release binary for compatibility gateway use.
     */
    fun installZeroClawCompat(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val targetPath = "$prefix/bin/zeroclaw"

        if (File(targetPath).exists()) return true

        val cmd = """
            rm -rf "$prefix/tmp/_zeroclaw_install" &&
            mkdir -p "$prefix/tmp/_zeroclaw_install" &&
            cd "$prefix/tmp/_zeroclaw_install" &&
            node -e '
              const https = require("https");
              const fs = require("fs");
              const url = "https://github.com/zeroclaw-labs/zeroclaw/releases/latest/download/zeroclaw-aarch64-unknown-linux-gnu.tar.gz";
              const file = fs.createWriteStream("zeroclaw.tar.gz");
              const fail = (e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); };
              const done = () => file.close(() => process.exit(0));
              const fetch = (u) => {
                https.get(u, (res) => {
                  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetch(res.headers.location); return;
                  }
                  if (res.statusCode < 200 || res.statusCode >= 300) {
                    fail(new Error("status " + res.statusCode)); return;
                  }
                  res.pipe(file);
                  file.on("finish", done);
                }).on("error", fail);
              };
              fetch(url);
            ' 2>&1 &&
            tar xzf zeroclaw.tar.gz 2>&1 &&
            BIN="${'$'}(find . -type f -name 'zeroclaw' | head -n 1)" &&
            [ -n "${'$'}BIN" ] &&
            cp "${'$'}BIN" "$targetPath" &&
            chmod 700 "$targetPath" &&
            rm -rf "$prefix/tmp/_zeroclaw_install" &&
            "$targetPath" --version 2>&1
        """.trimIndent()

        onProgress("Installing ZeroClaw compatibility layer…")
        val code = runInPrefix(cmd, onOutput = { onProgress(it) })
        if (code != 0) {
            Log.e(TAG, "zeroclaw compatibility install failed with code $code")
            return false
        }
        return isZeroClawCompatInstalled()
    }

    fun startPiGatewayCompat(): Boolean {
        if (piGatewayProcess != null) {
            try {
                piGatewayProcess!!.exitValue()
                piGatewayProcess = null
            } catch (_: IllegalThreadStateException) {
                Log.i(TAG, "Pi gateway compatibility process already running")
                return true
            }
        }

        if (!isZeroClawCompatInstalled()) {
            Log.w(TAG, "Cannot start Pi gateway compatibility without zeroclaw")
            return false
        }

        val paths = BootstrapInstaller.getPaths(context)
        runInPrefix(
            """
            for pid in ${'$'}(ls /proc 2>/dev/null | grep '^[0-9]'); do
              if cat /proc/${'$'}pid/cmdline 2>/dev/null | tr '\0' ' ' | grep -q "zeroclaw gateway"; then
                kill -9 ${'$'}pid 2>/dev/null
              fi
            done
            echo "Pi gateway process table cleaned"
            """.trimIndent()
        ) { Log.d(TAG, "[pi-gw] $it") }

        val env = buildEnvironment(paths).toMutableMap()
        env["PATH"] = "${paths.prefixDir}/bin:${paths.homeDir}/.local/bin:/system/bin"

        val shell = "${paths.prefixDir}/bin/sh"
        val cmd = "exec zeroclaw gateway --port $PI_GATEWAY_PORT 2>&1"

        val pb = ProcessBuilder(shell, "-c", cmd)
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        piGatewayProcess = proc

        Thread {
            val reader = BufferedReader(InputStreamReader(proc.inputStream))
            var line = reader.readLine()
            while (line != null) {
                Log.d(TAG, "[pi-gw] $line")
                line = reader.readLine()
            }
            Log.i(TAG, "Pi compatibility gateway exited with code: ${proc.waitFor()}")
        }.start()

        Thread.sleep(1500)
        val ready = isLocalPortOpen("127.0.0.1", PI_GATEWAY_PORT, timeoutMs = 3000)
        if (!ready) {
            Log.e(TAG, "Pi compatibility gateway failed health check on port $PI_GATEWAY_PORT")
        } else {
            Log.i(TAG, "Pi compatibility gateway started on port $PI_GATEWAY_PORT")
        }
        return ready
    }

    private fun ensurePiControlUiAssets(controlUiRoot: File) {
        controlUiRoot.mkdirs()
        val indexFile = File(controlUiRoot, "index.html")
        if (indexFile.exists()) return

        indexFile.writeText(
            """
            <!doctype html>
            <html lang="en">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1" />
              <title>ZombieClaw Pi Runtime</title>
              <style>
                body { margin: 0; padding: 24px; font-family: "Segoe UI", sans-serif; background: #f8fafc; color: #111827; }
                .card { max-width: 760px; margin: 0 auto; border: 1px solid #e4e4e7; border-radius: 14px; background: #fff; padding: 20px; }
                h1 { margin-top: 0; font-size: 1.25rem; }
                code { font-family: ui-monospace, Menlo, monospace; background: #f4f4f5; padding: 2px 6px; border-radius: 5px; }
              </style>
            </head>
            <body>
              <main class="card">
                <h1>Pi Runtime Compatibility</h1>
                <p>Gateway URL: <code>ws://127.0.0.1:$PI_GATEWAY_PORT</code></p>
                <p>This page is served locally so ZombieClaw can switch between Codex and Pi-compatible experiences inside one app shell.</p>
              </main>
            </body>
            </html>
            """.trimIndent()
        )
    }

    fun startPiControlUiServer(): Boolean {
        if (piControlUiProcess != null) {
            try {
                piControlUiProcess!!.exitValue()
                piControlUiProcess = null
            } catch (_: IllegalThreadStateException) {
                Log.i(TAG, "Pi Control UI server already running")
                return true
            }
        }

        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths)
        val controlUiRoot = File(paths.homeDir, ".anyclaw/pi-control-ui")
        ensurePiControlUiAssets(controlUiRoot)

        val shell = "${paths.prefixDir}/bin/sh"
        val serverScript = """
            node -e "
              const http = require('http');
              const fs = require('fs');
              const path = require('path');
              const root = '${controlUiRoot.absolutePath.replace("\\", "\\\\")}';
              http.createServer((req, res) => {
                let url = (req.url || '/').split('?')[0];
                if (url === '/') url = '/index.html';
                const filePath = path.join(root, url);
                if (!filePath.startsWith(root)) { res.writeHead(403); return res.end(); }
                fs.readFile(filePath, (err, data) => {
                  if (err) { res.writeHead(404); return res.end('Not found'); }
                  const ext = path.extname(filePath);
                  const mime = ext === '.html' ? 'text/html' : 'text/plain';
                  res.writeHead(200, { 'Content-Type': mime });
                  res.end(data);
                });
              }).listen($PI_CONTROL_UI_PORT, '127.0.0.1', () => console.log('Pi Control UI on port $PI_CONTROL_UI_PORT'));
            " 2>&1
        """.trimIndent()

        val pb = ProcessBuilder(shell, "-c", "exec $serverScript")
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        piControlUiProcess = proc

        Thread {
            val reader = BufferedReader(InputStreamReader(proc.inputStream))
            var line = reader.readLine()
            while (line != null) {
                Log.d(TAG, "[pi-ui] $line")
                line = reader.readLine()
            }
            Log.i(TAG, "Pi Control UI server exited with code: ${proc.waitFor()}")
        }.start()

        Thread.sleep(1000)
        val ready = isLocalPortOpen("127.0.0.1", PI_CONTROL_UI_PORT, timeoutMs = 3000)
        if (!ready) {
            Log.e(TAG, "Pi Control UI failed health check on port $PI_CONTROL_UI_PORT")
        } else {
            Log.i(TAG, "Pi Control UI server started on port $PI_CONTROL_UI_PORT")
        }
        return ready
    }

    fun installCodex(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val npmCli = "$prefix/lib/node_modules/npm/bin/npm-cli.js"

        onProgress("Installing Codex CLI…")
        val codexCode = runInPrefix(
            "node $npmCli install -g @openai/codex 2>&1",
            onOutput = { onProgress(it) },
        )
        if (codexCode != 0) {
            Log.e(TAG, "npm install @openai/codex failed with code $codexCode")
            return false
        }

        ensureCodexWrapperScript()
        return isCodexInstalled()
    }

    fun ensureCodexWrapperScript() {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val codexJs = File(prefix, "lib/node_modules/@openai/codex/bin/codex.js")
        val codexBin = File(prefix, "bin/codex")

        if (!codexJs.exists()) return
        if (codexBin.exists()) return

        val wrapperCmd = """
            rm -f "$prefix/bin/codex"
            cat > "$prefix/bin/codex" << 'WEOF'
#!/data/user/0/com.codex.mobile/files/usr/bin/sh
exec /data/user/0/com.codex.mobile/files/usr/bin/node /data/user/0/com.codex.mobile/files/usr/lib/node_modules/@openai/codex/bin/codex.js "${'$'}@"
WEOF
            chmod 700 "$prefix/bin/codex"
            echo "codex wrapper created"
        """.trimIndent()
        runInPrefix(wrapperCmd)
        Log.i(TAG, "Created codex wrapper at $codexBin")
    }

    fun installServerBundle(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val targetDir = File(paths.prefixDir, "lib/node_modules/codex-web-local")

        try {
            val assetFiles = context.assets.list("server-bundle") ?: emptyArray()
            if (assetFiles.isNotEmpty()) {
                onProgress("Installing server bundle from APK…")
                targetDir.deleteRecursively()
                targetDir.mkdirs()
                extractAssetDir("server-bundle", targetDir)
                Log.i(TAG, "Server bundle extracted to $targetDir")
                return true
            }
        } catch (e: Exception) {
            Log.d(TAG, "No bundled server-bundle asset, will use npm: ${e.message}")
        }

        return false
    }

    /**
     * Install the platform-specific native Codex binary.
     * npm refuses to install it on android (os mismatch), so we download
     * the tarball via Node.js and extract it manually.
     */
    fun installPlatformBinary(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val targetPkg = "$prefix/lib/node_modules/@openai/codex-linux-arm64"

        onProgress("Downloading Codex native binary…")

        // Use Node.js (which has working TLS) to download the npm tarball
        val installCmd = """
            mkdir -p "$prefix/tmp/_codex_bin" && cd "$prefix/tmp/_codex_bin" &&
            node -e '
              const https = require("https");
              const fs = require("fs");
              const url = "https://registry.npmjs.org/@openai/codex/-/codex-$CODEX_VERSION-linux-arm64.tgz";
              const file = fs.createWriteStream("codex-bin.tgz");
              https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                  https.get(res.headers.location, (r2) => r2.pipe(file).on("finish", () => {
                    file.close(); console.log("Downloaded"); process.exit(0);
                  }));
                } else {
                  res.pipe(file).on("finish", () => {
                    file.close(); console.log("Downloaded"); process.exit(0);
                  });
                }
              }).on("error", (e) => { console.error(e.message); process.exit(1); });
            ' 2>&1 &&
            tar xzf codex-bin.tgz 2>&1 &&
            mkdir -p "$targetPkg/vendor/aarch64-unknown-linux-musl/codex" &&
            cp package/vendor/aarch64-unknown-linux-musl/codex/codex "$targetPkg/vendor/aarch64-unknown-linux-musl/codex/codex" &&
            cp package/package.json "$targetPkg/package.json" &&
            chmod 700 "$targetPkg/vendor/aarch64-unknown-linux-musl/codex/codex" &&
            rm -rf "$prefix/tmp/_codex_bin" &&
            echo "Platform binary installed"
        """.trimIndent()

        val code = runInPrefix(installCmd, onOutput = { onProgress(it) })
        if (code != 0) {
            Log.e(TAG, "Platform binary install failed with code $code")
            return false
        }

        return isPlatformBinaryInstalled()
    }

    // ── Proxy ────────────────────────────────────────────────────────────────

    /**
     * Start a Node.js CONNECT proxy so the static-musl codex binary can
     * resolve DNS and reach HTTPS endpoints. Node.js uses Android's native
     * resolver; the proxy forwards TCP connections transparently.
     */
    fun startProxy(): Boolean {
        if (proxyProcess != null) return true

        val paths = BootstrapInstaller.getPaths(context)
        val proxyScript = File(paths.homeDir, "proxy.js")

        // Always overwrite with the latest version from assets
        try {
            context.assets.open("proxy.js").use { input ->
                proxyScript.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to extract proxy.js asset: ${e.message}")
            return false
        }

        // Kill any orphaned proxy from a previous run
        val pidFile = File(paths.homeDir, ".proxy.pid")
        if (pidFile.exists()) {
            try {
                val oldPid = pidFile.readText().trim()
                ProcessBuilder("kill", oldPid).start().waitFor()
                Thread.sleep(500)
            } catch (_: Exception) {}
            pidFile.delete()
        }

        val env = buildEnvironment(paths)
        val shell = "${paths.prefixDir}/bin/sh"
        val cmd = "exec node ${proxyScript.absolutePath}"

        val pb = ProcessBuilder(shell, "-c", cmd)
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        proxyProcess = proc

        Thread {
            val reader = BufferedReader(InputStreamReader(proc.inputStream))
            var line = reader.readLine()
            while (line != null) {
                Log.d(TAG, "[proxy] $line")
                line = reader.readLine()
            }
            Log.i(TAG, "Proxy exited with code: ${proc.waitFor()}")
        }.start()

        Thread.sleep(800)
        Log.i(TAG, "CONNECT proxy started on 127.0.0.1:$PROXY_PORT")
        return true
    }

    fun stopProxy() {
        proxyProcess?.destroy()
        proxyProcess = null
    }

    // ── Authentication ──────────────────────────────────────────────────────

    private fun codexBinPath(): String {
        val paths = BootstrapInstaller.getPaths(context)
        return "${paths.prefixDir}/lib/node_modules/@openai/codex-linux-arm64" +
            "/vendor/aarch64-unknown-linux-musl/codex/codex"
    }

    fun isLoggedIn(): Boolean {
        val output = runCapture("${codexBinPath()} login status 2>&1")
        Log.i(TAG, "Login status: $output")
        return !output.contains("Not logged in", ignoreCase = true)
    }

    /**
     * Pipe an API key into `codex login --with-api-key` via stdin.
     */
    fun loginWithApiKey(apiKey: String): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths)

        val pb = ProcessBuilder(codexBinPath(), "login", "--with-api-key")
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        proc.outputStream.bufferedWriter().use { w ->
            w.write(apiKey)
            w.newLine()
            w.flush()
        }

        val reader = BufferedReader(InputStreamReader(proc.inputStream))
        var line = reader.readLine()
        while (line != null) {
            Log.d(TAG, "[login] $line")
            line = reader.readLine()
        }

        val exitCode = proc.waitFor()
        Log.i(TAG, "codex login --with-api-key exited with code $exitCode")
        return exitCode == 0
    }

    /**
     * Run `codex login` (URL-based OAuth flow) using the CONNECT proxy.
     * The native binary starts a local HTTP server for the OAuth callback,
     * prints an auth URL, and waits for the redirect. Parses the URL from
     * stdout and calls [onLoginUrl] so the Activity can open the browser.
     * Blocks until login completes or fails.
     */
    fun loginWithUrl(
        onLoginUrl: (url: String) -> Unit,
        onProgress: (String) -> Unit,
    ): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths).toMutableMap()
        env["HTTPS_PROXY"] = "http://127.0.0.1:$PROXY_PORT"
        env["HTTP_PROXY"] = "http://127.0.0.1:$PROXY_PORT"

        val pb = ProcessBuilder(codexBinPath(), "login")
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        val reader = BufferedReader(InputStreamReader(proc.inputStream))

        val urlRegex = Regex("""(https://auth\.openai\.com/\S+)""")
        var urlSent = false

        var line = reader.readLine()
        while (line != null) {
            val clean = line.replace(Regex("\\x1b\\[[0-9;]*m"), "").trim()
            Log.d(TAG, "[login] $clean")
            onProgress(clean)

            if (!urlSent) {
                urlRegex.find(clean)?.let {
                    onLoginUrl(it.value)
                    urlSent = true
                }
            }

            line = reader.readLine()
        }

        val exitCode = proc.waitFor()
        Log.i(TAG, "codex login exited with code $exitCode")
        return exitCode == 0
    }

    // ── Health check ────────────────────────────────────────────────────────

    /**
     * Send a minimal prompt ("hi") to Codex in non-interactive (exec) mode
     * via the CONNECT proxy. Confirms the API key is valid and the native
     * binary can reach OpenAI.
     */
    fun healthCheck(onProgress: (String) -> Unit): Boolean {
        onProgress("Sending test message…")

        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths).toMutableMap()
        env["HTTPS_PROXY"] = "http://127.0.0.1:$PROXY_PORT"
        env["HTTP_PROXY"] = "http://127.0.0.1:$PROXY_PORT"

        val shell = "${paths.prefixDir}/bin/sh"
        val cmd = "${codexBinPath()} exec --skip-git-repo-check \"say hi\" 2>&1"

        val pb = ProcessBuilder(shell, "-c", cmd)
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        val sb = StringBuilder()
        val reader = BufferedReader(InputStreamReader(proc.inputStream))
        var line = reader.readLine()
        while (line != null) {
            val clean = line.replace(Regex("\\x1b\\[[0-9;]*m"), "").trim()
            Log.d(TAG, "[health] $clean")
            sb.appendLine(clean)
            onProgress(clean)
            line = reader.readLine()
        }

        val exitCode = proc.waitFor()
        val output = sb.toString().trim()
        Log.i(TAG, "Health check exit=$exitCode output=$output")

        if (exitCode != 0) {
            Log.e(TAG, "Health check failed with exit code $exitCode")
            return false
        }

        return output.isNotEmpty()
    }

    // ── Server lifecycle ────────────────────────────────────────────────────

    /**
     * Start the codex-web-local server. The CONNECT proxy must be running
     * and authentication must have been completed first.
     */
    fun startServer(): Boolean {
        if (isRunning) {
            Log.i(TAG, "Server already running")
            return true
        }

        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths).toMutableMap()
        env["HTTPS_PROXY"] = "http://127.0.0.1:$PROXY_PORT"
        env["HTTP_PROXY"] = "http://127.0.0.1:$PROXY_PORT"

        val serverScript = "${paths.prefixDir}/lib/node_modules/codex-web-local/dist-cli/index.js"
        if (!File(serverScript).exists()) {
            Log.e(TAG, "Server script not found: $serverScript")
            return false
        }

        val shell = "${paths.prefixDir}/bin/sh"
        val command = "exec node $serverScript --port $SERVER_PORT --no-password"

        Log.i(TAG, "Starting server: $command")

        val pb = ProcessBuilder(shell, "-c", command)
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        serverProcess = proc

        Thread {
            val reader = BufferedReader(InputStreamReader(proc.inputStream))
            var line = reader.readLine()
            while (line != null) {
                Log.d(TAG, "[server] $line")
                line = reader.readLine()
            }
            Log.i(TAG, "Server process exited with code: ${proc.waitFor()}")
        }.start()

        return true
    }

    fun waitForServer(timeoutMs: Long = 60_000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        val url = URL("http://127.0.0.1:$SERVER_PORT/")

        while (System.currentTimeMillis() < deadline) {
            try {
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 2000
                conn.readTimeout = 2000
                conn.requestMethod = "GET"
                val code = conn.responseCode
                conn.disconnect()
                if (code in 200..399) {
                    Log.i(TAG, "Server is ready (HTTP $code)")
                    return true
                }
            } catch (_: Exception) {
                // Not ready yet
            }
            Thread.sleep(500)
        }

        Log.e(TAG, "Server did not become ready within ${timeoutMs}ms")
        return false
    }

    fun stopServer() {
        val proc = serverProcess ?: return
        serverProcess = null

        try {
            proc.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "Error destroying server process: ${e.message}")
        }

        try {
            proc.waitFor()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }

        stopPiRuntime()
        stopProxy()
        Log.i(TAG, "Server stopped")
    }

    private fun stopPiRuntime() {
        piGatewayProcess?.destroy()
        piGatewayProcess = null
        piControlUiProcess?.destroy()
        piControlUiProcess = null
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun extractAssetDir(assetPath: String, targetDir: File) {
        val list = context.assets.list(assetPath) ?: return
        targetDir.mkdirs()
        for (entry in list) {
            val subAsset = "$assetPath/$entry"
            val subTarget = File(targetDir, entry)
            val subList = context.assets.list(subAsset)
            if (subList != null && subList.isNotEmpty()) {
                subTarget.mkdirs()
                extractAssetDir(subAsset, subTarget)
            } else {
                context.assets.open(subAsset).use { input ->
                    subTarget.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
            }
        }
    }

    fun ensureDefaultWorkspace() {
        val paths = BootstrapInstaller.getPaths(context)
        val workspaceDir = File(paths.homeDir, "codex")
        if (workspaceDir.exists()) return

        workspaceDir.mkdirs()
        runInPrefix("cd ${workspaceDir.absolutePath} && git init 2>&1")
        Log.i(TAG, "Created default workspace at $workspaceDir")
    }

    fun ensureFullAccessConfig() {
        val paths = BootstrapInstaller.getPaths(context)
        val configDir = File(paths.homeDir, ".codex")
        configDir.mkdirs()
        val configFile = File(configDir, "config.toml")
        val desired = """
            |approval_policy = "never"
            |sandbox_mode = "danger-full-access"
        """.trimMargin().trim() + "\n"

        if (configFile.exists()) {
            val current = configFile.readText()
            if (current.contains("approval_policy") && current.contains("danger-full-access")) {
                return
            }
        }
        configFile.writeText(desired)
        Log.i(TAG, "Wrote full-access config to $configFile")
    }

    private fun buildEnvironment(
        paths: BootstrapInstaller.Paths,
    ): Map<String, String> {
        val bionicCompat = "${paths.homeDir}/.anyclaw/patches/bionic-compat.js"
        val bionicCompatOpt = if (File(bionicCompat).exists()) " -r $bionicCompat" else ""

        return mapOf(
            "PREFIX" to paths.prefixDir,
            "HOME" to paths.homeDir,
            "PATH" to "${paths.prefixDir}/bin:${paths.prefixDir}/bin/applets:/system/bin",
            "LD_LIBRARY_PATH" to "${paths.prefixDir}/lib",
            "LD_PRELOAD" to "${paths.prefixDir}/lib/libtermux-exec.so",
            "TERMUX_PREFIX" to paths.prefixDir,
            "TERMUX__PREFIX" to paths.prefixDir,
            "LANG" to "en_US.UTF-8",
            "TMPDIR" to paths.tmpDir,
            "TMP" to paths.tmpDir,
            "TEMP" to paths.tmpDir,
            "PROOT_TMP_DIR" to paths.tmpDir,
            "TERM" to "xterm-256color",
            "ANDROID_DATA" to "/data",
            "ANDROID_ROOT" to "/system",
            "APT_CONFIG" to "${paths.prefixDir}/etc/apt/apt.conf",
            "DPKG_ADMINDIR" to "${paths.prefixDir}/var/lib/dpkg",
            "SSL_CERT_FILE" to "${paths.prefixDir}/etc/tls/cert.pem",
            "SSL_CERT_DIR" to "/system/etc/security/cacerts",
            "CURL_CA_BUNDLE" to "${paths.prefixDir}/etc/tls/cert.pem",
            "GIT_SSL_CAINFO" to "${paths.prefixDir}/etc/tls/cert.pem",
            "GIT_CONFIG_NOSYSTEM" to "1",
            "GIT_EXEC_PATH" to "${paths.prefixDir}/libexec/git-core",
            "GIT_TEMPLATE_DIR" to "${paths.prefixDir}/share/git-core/templates",
            "OPENSSL_CONF" to "${paths.prefixDir}/etc/tls/openssl.cnf",
            "NODE_OPTIONS" to "--openssl-config=${paths.prefixDir}/etc/tls/openssl.cnf --unhandled-rejections=warn$bionicCompatOpt",
            "CONTAINER" to "1",
        )
    }

    private fun isLocalPortOpen(host: String, port: Int, timeoutMs: Int = 1500): Boolean {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }
}
