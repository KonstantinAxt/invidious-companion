import {
    installCamoufox,
    isConfiguredCamoufoxInstalled,
} from "./packageManager.ts";
import { BrowserPoTokenUnavailableError } from "../potoken/errors.ts";

export function configureInstallDirectory(): string | undefined {
    let installDirectory = Deno.env.get("CAMOUFOX_INSTALL_DIR");
    if (!installDirectory && Deno.build.os === "linux") {
        installDirectory = "/var/tmp/youtubei.js/camoufox";
        Deno.env.set("CAMOUFOX_INSTALL_DIR", installDirectory);
    }
    return installDirectory;
}

export async function configureTemporaryDirectory(): Promise<void> {
    if (Deno.env.has("TMPDIR")) return;
    const tempDirectory = "/var/tmp/youtubei.js/tmp";
    try {
        await Deno.mkdir(tempDirectory, { recursive: true });
        Deno.env.set("TMPDIR", tempDirectory);
    } catch (error) {
        throw new BrowserPoTokenUnavailableError(
            `Camoufox temporary directory could not be created at ${tempDirectory}`,
            { cause: error },
        );
    }
}

export async function ensureCamoufoxInstalled(
    installDirectory: string,
): Promise<void> {
    try {
        if (await isConfiguredCamoufoxInstalled(installDirectory)) return;
    } catch (error) {
        if (browserDownloadDisabled()) {
            throw new BrowserPoTokenUnavailableError(
                `Camoufox is not installed at ${installDirectory}`,
                { cause: error },
            );
        }
    }

    console.log("[INFO] Camoufox is not installed; downloading it", {
        installDirectory,
    });
    try {
        await installCamoufox(installDirectory);

        const executable = await Deno.stat(
            `${installDirectory}/camoufox-bin`,
        );
        if (!executable.isFile) throw new Error("not a file");
    } catch (error) {
        throw new BrowserPoTokenUnavailableError(
            `Camoufox could not be installed at ${installDirectory}`,
            { cause: error },
        );
    }
}

export function browserDownloadDisabled(): boolean {
    const value = Deno.env.get("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD");
    return Boolean(value && value !== "0" && value !== "false");
}

export function fingerprintOperatingSystem(): "linux" | "macos" | "windows" {
    if (Deno.build.os === "darwin") return "macos";
    if (Deno.build.os === "windows") return "windows";
    return "linux";
}

export async function prepareCamoufoxInstall(): Promise<string | undefined> {
    const installDirectory = configureInstallDirectory();
    if (Deno.build.os === "linux" && installDirectory) {
        await configureTemporaryDirectory();
        await ensureCamoufoxInstalled(installDirectory);
    }
    return installDirectory;
}
