import { Innertube } from "youtubei.js";
import { firefox } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { PLAYER_ID } from "../../constants.ts";
import {
    type FetchFunction,
    getAttestationChallenge,
    getIntegrityToken,
} from "../potoken/attestation.ts";
import {
    createMinter,
    destroyAllGenerationsOnPage,
    destroyGenerationOnPage,
    initializePoTokenPage,
    mintOnPage,
    runBotGuard,
} from "../potoken/browserPage.ts";
import { launchCamoufox } from "../camoufox/browser.ts";
import {
    fingerprintOperatingSystem,
    prepareCamoufoxInstall,
} from "../camoufox/install.ts";
import { BrowserPoTokenUnavailableError } from "../potoken/errors.ts";

export interface CamoufoxPoTokenGeneration {
    sessionPoToken: string;
    visitorData: string;
    userAgent: string;
    mint(contentBinding: string): Promise<string>;
    activate(): Promise<void>;
    discard(): Promise<void>;
}

class CamoufoxPoTokenRuntime {
    private browser?: Browser;
    private context?: BrowserContext;
    private page?: Page;
    private generationIds = new Set<string>();
    private activeGenerationId?: string;
    private previousGenerationId?: string;
    private mintOperations = new Map<string, Set<Promise<string>>>();
    private operationTail: Promise<void> = Promise.resolve();

    createGeneration(
        fetchImpl: FetchFunction,
        cookies: string,
    ): Promise<CamoufoxPoTokenGeneration> {
        return this.enqueue(async () => {
            const page = await this.ensurePage();
            const generationId = crypto.randomUUID();

            try {
                const userAgent = await page.evaluate(() =>
                    navigator.userAgent
                );
                const bootstrapClient = await Innertube.create({
                    enable_session_cache: false,
                    fetch: fetchImpl,
                    user_agent: userAgent,
                    retrieve_player: false,
                    cookie: cookies || undefined,
                    player_id: PLAYER_ID,
                });
                const visitorData =
                    bootstrapClient.session.context.client.visitorData;
                if (!visitorData) {
                    throw new Error("Could not get visitor data");
                }

                const challenge = await getAttestationChallenge(
                    bootstrapClient,
                    fetchImpl,
                    userAgent,
                );
                const botguardResponse = await runBotGuard(
                    page,
                    generationId,
                    challenge,
                );
                const integrityToken = await getIntegrityToken(
                    fetchImpl,
                    userAgent,
                    botguardResponse,
                );
                await createMinter(page, generationId, integrityToken);
                this.generationIds.add(generationId);

                const sessionPoToken = await mintOnPage(
                    page,
                    generationId,
                    visitorData,
                );
                let disposed = false;

                return {
                    sessionPoToken,
                    visitorData,
                    userAgent,
                    mint: (contentBinding) => {
                        if (disposed) {
                            return Promise.reject(
                                new Error("PO token generation was retired"),
                            );
                        }
                        return this.mint(generationId, contentBinding);
                    },
                    activate: async () => {
                        if (disposed) {
                            throw new Error("PO token generation was retired");
                        }
                        await this.activate(generationId);
                    },
                    discard: async () => {
                        if (disposed) return;
                        disposed = true;
                        await this.discard(generationId);
                    },
                };
            } catch (error) {
                await destroyGenerationOnPage(page, generationId).catch(
                    () => {},
                );
                this.generationIds.delete(generationId);
                throw error;
            }
        });
    }

    close(): Promise<void> {
        return this.enqueue(() => this.closeBrowser());
    }

    private async mint(
        generationId: string,
        contentBinding: string,
    ): Promise<string> {
        if (!this.generationIds.has(generationId)) {
            throw new Error("PO token generation is no longer available");
        }
        const page = this.getLivePage();
        const operation = mintOnPage(page, generationId, contentBinding);
        const operations = this.mintOperations.get(generationId) ?? new Set();
        operations.add(operation);
        this.mintOperations.set(generationId, operations);
        try {
            return await operation;
        } finally {
            operations.delete(operation);
            if (operations.size === 0) {
                this.mintOperations.delete(generationId);
            }
        }
    }

    private activate(generationId: string): Promise<void> {
        return this.enqueue(async () => {
            if (!this.generationIds.has(generationId)) {
                throw new Error(
                    "Cannot activate an unavailable PO token generation",
                );
            }
            if (this.activeGenerationId === generationId) return;

            const staleGenerationId = this.previousGenerationId;
            this.previousGenerationId = this.activeGenerationId;
            this.activeGenerationId = generationId;

            if (staleGenerationId) {
                await this.destroyGeneration(staleGenerationId).catch(
                    (error) => {
                        console.warn(
                            "[WARN] Failed to retire old PO token state",
                            {
                                error,
                            },
                        );
                    },
                );
            }
        });
    }

    private discard(generationId: string): Promise<void> {
        return this.enqueue(async () => {
            if (
                generationId === this.activeGenerationId ||
                generationId === this.previousGenerationId
            ) {
                return;
            }
            await this.destroyGeneration(generationId);
        });
    }

    private async destroyGeneration(generationId: string): Promise<void> {
        if (!this.generationIds.delete(generationId)) return;
        await Promise.allSettled(this.mintOperations.get(generationId) ?? []);
        const page = this.page;
        if (page && !page.isClosed()) {
            await destroyGenerationOnPage(page, generationId);
        }
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation);
        this.operationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    private getLivePage(): Page {
        if (!this.page || this.page.isClosed()) {
            throw new Error("Camoufox page is unavailable");
        }
        return this.page;
    }

    private async ensurePage(): Promise<Page> {
        if (this.browser?.isConnected() && this.page && !this.page.isClosed()) {
            return this.page;
        }

        await this.closeBrowser();

        const remoteEndpoint = Deno.env.get("CAMOUFOX_REMOTE_WS_ENDPOINT");
        let browser: Browser;
        let installDirectory: string | undefined;
        if (remoteEndpoint) {
            try {
                browser = await firefox.connect(remoteEndpoint);
            } catch (error) {
                throw new BrowserPoTokenUnavailableError(
                    "Could not connect to remote Camoufox server",
                    { cause: error },
                );
            }
        } else {
            installDirectory = await prepareCamoufoxInstall();
            try {
                browser = await launchCamoufox(fingerprintOperatingSystem());
            } catch (error) {
                throw new BrowserPoTokenUnavailableError(
                    "Camoufox could not be imported or launched",
                    { cause: error },
                );
            }
        }

        try {
            const context = await browser.newContext({ viewport: null });
            const page = await context.newPage();
            await initializePoTokenPage(page);

            this.browser = browser;
            this.context = context;
            this.page = page;
            browser.once("disconnected", () => this.invalidate(browser, page));
            page.once("crash", () => this.invalidate(browser, page));
            page.once("close", () => this.invalidate(browser, page));
            console.log("[INFO] Camoufox PO token page is ready", {
                installDirectory,
            });
            return page;
        } catch (error) {
            await browser.close().catch(() => {});
            throw new BrowserPoTokenUnavailableError(
                "Camoufox could not initialize its PO token page",
                { cause: error },
            );
        }
    }

    private invalidate(browser: Browser, page: Page): void {
        if (this.browser !== browser || this.page !== page) return;
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        this.generationIds.clear();
        this.activeGenerationId = undefined;
        this.previousGenerationId = undefined;
        if (browser.isConnected()) void browser.close().catch(() => {});
    }

    private async closeBrowser(): Promise<void> {
        const browser = this.browser;
        const context = this.context;
        const page = this.page;
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        this.generationIds.clear();
        this.activeGenerationId = undefined;
        this.previousGenerationId = undefined;

        await Promise.allSettled(
            [...this.mintOperations.values()].flatMap((
                operations,
            ) => [...operations]),
        );
        this.mintOperations.clear();

        if (page && !page.isClosed()) {
            await destroyAllGenerationsOnPage(page).catch(() => {});
        }
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
    }
}

const runtime = new CamoufoxPoTokenRuntime();

export function createCamoufoxPoTokenGeneration(
    fetchImpl: FetchFunction,
    cookies: string,
): Promise<CamoufoxPoTokenGeneration> {
    return runtime.createGeneration(fetchImpl, cookies);
}

export function closeCamoufoxPoTokenRuntime(): Promise<void> {
    return runtime.close();
}
