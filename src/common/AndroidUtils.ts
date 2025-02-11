/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */
import { Logger, Messages, SfdxError } from '@salesforce/core';
import * as childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import util from 'util';
import {
    AndroidPackage,
    AndroidPackages,
    AndroidVirtualDevice
} from './AndroidTypes';
import { Version } from './Common';
import { CommonUtils } from './CommonUtils';
import { PlatformConfig } from './PlatformConfig';
import { LaunchArgument } from './PreviewConfigFile';
import { PreviewUtils } from './PreviewUtils';

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages(
    '@salesforce/lwc-dev-mobile-core',
    'common'
);

const LOGGER_NAME = 'force:lightning:local:androidutils';
const WINDOWS_OS = 'win32';
const ANDROID_SDK_MANAGER_NAME = 'sdkmanager';
const ANDROID_AVD_MANAGER_NAME = 'avdmanager';
const ANDROID_ADB_NAME = 'adb';

export enum AndroidSDKRootSource {
    androidHome = 'ANDROID_HOME',
    androidSDKRoot = 'ANDROID_SDK_ROOT'
}

export interface AndroidSDKRoot {
    rootLocation: string;
    rootSource: AndroidSDKRootSource;
}

export class AndroidUtils {
    /**
     * Initialized the logger used by AndroidUtils
     */
    public static async initializeLogger(): Promise<void> {
        AndroidUtils.logger = await Logger.child(LOGGER_NAME);
        return Promise.resolve();
    }

    /**
     * Converts a path to UNIX style path.
     *
     * @param dirPath Input path.
     * @returns UNIX style path.
     */
    public static convertToUnixPath(dirPath: string): string {
        return dirPath.replace(/[\\]+/g, '/');
    }

    /**
     * Indicates whether Android packages are cached or not.
     *
     * @returns True if cached, False otherwise.
     */
    public static isCached(): boolean {
        return !AndroidUtils.packageCache.isEmpty();
    }

    /**
     * Indicates whether user has set a value for JAVA_HOME environment variable.
     *
     * @returns True if set, False otherwise.
     */
    public static isJavaHomeSet(): boolean {
        return process.env.JAVA_HOME
            ? process.env.JAVA_HOME.trim().length > 0
            : false;
    }

    /**
     * Clears all caches that AndroidUtils uses.
     */
    public static clearCaches() {
        AndroidUtils.emulatorCommand = undefined;
        AndroidUtils.androidCmdLineToolsBin = undefined;
        AndroidUtils.androidPlatformTools = undefined;
        AndroidUtils.avdManagerCommand = undefined;
        AndroidUtils.adbShellCommand = undefined;
        AndroidUtils.sdkManagerCommand = undefined;
        AndroidUtils.sdkRoot = undefined;
        AndroidUtils.packageCache = new AndroidPackages();
    }

    /**
     * Attempt to run sdkmanager and see if it throws any exceptions. If no errors are encountered then all prerequisites are met.
     * But if an error is encountered then we'll try to see if it is due to unsupported Java version or something else.
     *
     * @returns If prerequisites are met, then returns the location of Android command line tools.
     */
    public static async androidSDKPrerequisitesCheck(): Promise<string> {
        return AndroidUtils.fetchAndroidCmdLineToolsLocation()
            .then((result) => Promise.resolve(result))
            .catch((error) => {
                const e: Error = error;
                const stack = e.stack || '';
                const idx = stack.indexOf(
                    'java.lang.NoClassDefFoundError: javax/xml/bind/annotation/XmlSchema'
                );

                if (!AndroidUtils.isJavaHomeSet()) {
                    return Promise.reject(
                        new SfdxError('JAVA_HOME is not set.')
                    );
                } else if (idx !== -1) {
                    return Promise.reject(
                        new SfdxError('unsupported Java version.')
                    );
                } else if (error.status && error.status === 127) {
                    return Promise.reject(
                        new SfdxError(
                            `SDK Manager not found. Expected at ${AndroidUtils.getSdkManagerCommand()}`
                        )
                    );
                } else {
                    return Promise.reject(error);
                }
            });
    }

    /**
     * Attempts to fetch the location of Android command line tools.
     *
     * @returns The location of Android command line tools.
     */
    public static async fetchAndroidCmdLineToolsLocation(): Promise<string> {
        if (!AndroidUtils.getAndroidSdkRoot()) {
            return Promise.reject(
                new SfdxError('Android SDK root is not set.')
            );
        }

        return CommonUtils.executeCommandAsync(
            `${AndroidUtils.getSdkManagerCommand()} --version`
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ).then((result) =>
            Promise.resolve(AndroidUtils.getAndroidCmdLineToolsBin())
        );
    }

    /**
     * Attempts to fetch the location of Android platform tools.
     *
     * @returns The location of Android platform tools.
     */
    public static async fetchAndroidSDKPlatformToolsLocation(): Promise<string> {
        if (!AndroidUtils.getAndroidSdkRoot()) {
            return Promise.reject(
                new SfdxError('Android SDK root is not set.')
            );
        }

        return CommonUtils.executeCommandAsync(
            `${AndroidUtils.getAdbShellCommand()} --version`
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ).then((result) =>
            Promise.resolve(AndroidUtils.getAndroidPlatformTools())
        );
    }

    /**
     * Attempts to fetch all Android packages that are installed on a user's machine.
     *
     * @returns The installed packages.
     */
    public static async fetchInstalledPackages(): Promise<AndroidPackages> {
        if (!AndroidUtils.getAndroidSdkRoot()) {
            return Promise.reject(
                new SfdxError('Android SDK root is not set.')
            );
        }

        if (AndroidUtils.isCached()) {
            return Promise.resolve(AndroidUtils.packageCache);
        }

        return CommonUtils.executeCommandAsync(
            `${AndroidUtils.getSdkManagerCommand()} --list`
        ).then((result) => {
            if (result.stdout && result.stdout.length > 0) {
                const packages = AndroidPackages.parseRawPackagesString(
                    result.stdout
                );
                AndroidUtils.packageCache = packages;
            }
            return Promise.resolve(AndroidUtils.packageCache);
        });
    }

    /**
     * Attempts to fetch all supported Android device types (e.g Pixel, Pixel_XL, Pixel_C)
     *
     * @returns The supported Android device types.
     */
    public static async getSupportedDevices(): Promise<string[]> {
        return Promise.resolve(
            PlatformConfig.androidConfig().supportedDeviceTypes
        );
    }

    /**
     * Attempts to fetch all available Android virtual devices.
     *
     * @returns An array of all available Android virtual devices.
     */
    public static async fetchEmulators(): Promise<AndroidVirtualDevice[]> {
        let devices: AndroidVirtualDevice[] = [];
        return CommonUtils.executeCommandAsync(
            AndroidUtils.getAvdManagerCommand() + ' list avd'
        )
            .then((result) => {
                if (result.stdout && result.stdout.length > 0) {
                    devices = AndroidVirtualDevice.parseRawString(
                        result.stdout
                    );
                }
                return Promise.resolve(devices);
            })
            .catch((error) => {
                AndroidUtils.logger.warn(error);
                return Promise.resolve(devices);
            });
    }

    /**
     * Attempts to fetch a specific Android virtual device.
     *
     * @returns An AndroidVirtualDevice object for the specified virtual device, or undefined if device not found.
     */
    public static async fetchEmulator(
        emulatorName: string
    ): Promise<AndroidVirtualDevice | undefined> {
        return AndroidUtils.resolveEmulatorImage(emulatorName).then(
            async (resolvedEmulator) => {
                if (!resolvedEmulator) {
                    return Promise.resolve(undefined);
                }

                const emulators = await AndroidUtils.fetchEmulators();
                for (const emulator of emulators) {
                    if (emulator.name === resolvedEmulator) {
                        return Promise.resolve(emulator);
                    }
                }

                return Promise.resolve(undefined);
            }
        );
    }

    /**
     * Attempts to find all Android API packages that are installed on a user's machine and that are above minSupportedRuntime version
     * (and optionally that have matching supported emulator images).
     *
     * @param mustHaveSupportedEmulatorImages Indicates whether the API packages must have matching supported emulator images.
     * @returns An array of Android API packages meeting the conditions.
     */
    public static async fetchAllAvailableApiPackages(
        mustHaveSupportedEmulatorImages: boolean
    ): Promise<AndroidPackage[]> {
        const minSupportedRuntime = Version.from(
            PlatformConfig.androidConfig().minSupportedRuntime
        );

        return AndroidUtils.fetchInstalledPackages()
            .then((allPackages) => {
                if (allPackages.isEmpty()) {
                    return Promise.reject(
                        new SfdxError(
                            `No Android API packages are installed. Minimum supported Android API package version is ${
                                PlatformConfig.androidConfig()
                                    .minSupportedRuntime
                            }`
                        )
                    );
                }

                const matchingPlatforms = allPackages.platforms.filter((pkg) =>
                    pkg.version.sameOrNewer(minSupportedRuntime)
                );

                if (matchingPlatforms.length < 1) {
                    return Promise.reject(
                        new SfdxError(
                            `Could not locate a supported Android API package. Minimum supported Android API package version is ${
                                PlatformConfig.androidConfig()
                                    .minSupportedRuntime
                            }`
                        )
                    );
                }

                return Promise.resolve(matchingPlatforms);
            })
            .then(async (matchingPlatforms) => {
                let results: AndroidPackage[] = [];

                if (mustHaveSupportedEmulatorImages) {
                    for (const pkg of matchingPlatforms) {
                        try {
                            const emulatorImage =
                                await AndroidUtils.packageWithRequiredEmulatorImages(
                                    pkg
                                );

                            // if it has a supported emulator image then include it
                            if (emulatorImage) {
                                results.push(pkg);
                            }
                        } catch (error) {
                            this.logger.warn(
                                `Could not find emulator image for Android API package ${pkg.path}: ${error}`
                            );
                        }
                    }
                } else {
                    results = matchingPlatforms;
                }

                // Sort the packages with latest version by negating the comparison result
                results.sort((a, b) => a.version.compare(b.version) * -1);
                return Promise.resolve(results);
            });
    }

    /**
     * Checks for and returns a supported Android API package that also has matching supported emulator images installed.
     *
     * @param apiLevel Optional parameter. When defined, it indicates a specific API level to find the API package for.
     * When not defined, the latest supported API package (with matching supported emulator images) that is installed
     * on user's machine is fetched. Defaults to undefined.
     * @returns A supported Android API package.
     */
    public static async fetchSupportedAndroidAPIPackage(
        apiLevel?: string
    ): Promise<AndroidPackage> {
        const targetRuntime: Version | undefined = apiLevel
            ? Version.from(apiLevel)
            : undefined;

        return AndroidUtils.fetchAllAvailableApiPackages(true).then(
            (packages) => {
                let matchingPlatforms = packages;
                if (targetRuntime) {
                    matchingPlatforms = packages.filter((pkg) =>
                        pkg.version.same(targetRuntime)
                    );
                    if (matchingPlatforms.length < 1) {
                        return Promise.reject(
                            new SfdxError(
                                `Could not locate Android API package (with matching emulator images) for API level ${apiLevel}.`
                            )
                        );
                    }
                }

                if (matchingPlatforms.length < 1) {
                    return Promise.reject(
                        new SfdxError(
                            `Could not locate a supported Android API package with matching emulator images. Minimum supported Android API package version is ${
                                PlatformConfig.androidConfig()
                                    .minSupportedRuntime
                            }`
                        )
                    );
                }

                return Promise.resolve(matchingPlatforms[0]);
            }
        );
    }

    /**
     * Attempts to fetch the Android package for a supported emulator image target (e.g. Google APIs, default, Google Play).
     *
     * @param apiLevel Optional parameter. When defined, it indicates a specific API level to find the emulator package for.
     * When not defined, the latest supported API level that is installed on user's machine is used. Defaults to undefined.
     * @returns Android package of a supported emulator.
     */
    public static async fetchSupportedEmulatorImagePackage(
        apiLevel?: string
    ): Promise<AndroidPackage> {
        let installedAndroidPackage: AndroidPackage;

        return AndroidUtils.fetchSupportedAndroidAPIPackage(apiLevel)
            .then((pkg) => {
                installedAndroidPackage = pkg;
                return AndroidUtils.packageWithRequiredEmulatorImages(
                    installedAndroidPackage
                );
            })
            .then((emulatorImage) => {
                if (emulatorImage) {
                    return Promise.resolve(emulatorImage);
                } else {
                    return Promise.reject(
                        new SfdxError(
                            `Could not locate an emulator image. Requires any one of these [${PlatformConfig.androidConfig().supportedImages.join(
                                ','
                            )} for ${[installedAndroidPackage.platformAPI]}]`
                        )
                    );
                }
            })
            .catch((error) => {
                this.logger.error(
                    `Could not find android emulator packages.\n${error}`
                );
                return Promise.reject(
                    new SfdxError(`Could not find android emulator packages.`)
                );
            });
    }

    /**
     * Checks whether an emulator with a given name is available.
     *
     * @param emulatorName Name of an emulator (e.g Pixel XL, Nexus_6_API_30).
     * @returns True if an emulator with a given name is available, False otherwise.
     */
    public static async hasEmulator(emulatorName: string): Promise<boolean> {
        return AndroidUtils.resolveEmulatorImage(emulatorName).then(
            (resolvedEmulator) =>
                Promise.resolve(resolvedEmulator !== undefined)
        );
    }

    /**
     * Attempts to create a new Android virtual device.
     *
     * @param emulatorName Name to be used for the emulator (e.g Pixel XL, Nexus_6_API_30).
     * @param emulatorImage An emulator image type to be used (e.g google_apis, default, google_apis_playstore)
     * @param platformAPI A platform API to be used (e.g android-30, android-28)
     * @param device A device type to be used (e.g pixel, pixel_xl, pixel_c)
     * @param abi The ABI to be used (e.g x86, x86_64)
     */
    public static async createNewVirtualDevice(
        emulatorName: string,
        emulatorImage: string,
        platformAPI: string,
        device: string,
        abi: string
    ): Promise<void> {
        // Just like Android Studio AVD Manager GUI interface, replace blank spaces with _ so that the ID of this AVD
        // doesn't have blanks (since that's not allowed). AVD Manager will automatically replace _ back with blank
        // to generate user friendly display names.
        const resolvedName = emulatorName.replace(/ /gi, '_');

        const createAvdCommand = `${AndroidUtils.getAvdManagerCommand()} create avd -n ${resolvedName} --force -k ${AndroidUtils.systemImagePath(
            platformAPI,
            emulatorImage,
            abi
        )} --device ${device} --abi ${abi}`;

        return new Promise((resolve, reject) => {
            try {
                const child = AndroidUtils.spawnChild(createAvdCommand);
                if (child) {
                    child.stdin.setDefaultEncoding('utf8');
                    child.stdin.write('no');
                    child.stdout.on('data', () => {
                        setTimeout(() => {
                            resolve(true);
                        }, 3000);
                    });
                    child.stdout.on('exit', () => resolve(true));
                    child.stderr.on('error', (err) => {
                        reject(
                            new SfdxError(
                                `Could not create emulator. Command failed: ${createAvdCommand}\n${err}`
                            )
                        );
                    });
                    child.stderr.on('data', (data: Buffer) => {
                        if (data.includes('Error:')) {
                            reject(
                                new SfdxError(
                                    `Could not create emulator. Command failed: ${createAvdCommand}\n${data}`
                                )
                            );
                        }
                    });
                } else {
                    reject(new SfdxError(`Could not create emulator.`));
                }
            } catch (error) {
                reject(new SfdxError(`Could not create emulator. ${error}`));
            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        }).then((resolve) => AndroidUtils.updateEmulatorConfig(resolvedName));
    }

    /**
     * Attempts to launch an emulator and returns the ADB port that the emulator was launched on.
     *
     * @param emulatorName Name of the emulator to be launched (e.g Pixel XL, Nexus_6_API_30).
     * @param writable Optional boolean indicating whether the emulator should launch with the '-writable-system' flag. Defaults to false.
     * @param waitForBoot Optional boolean indicating whether it should wait for the device to finish booting up. Defaults to true.
     * @returns The ADB port that the emulator was launched on.
     */
    public static async startEmulator(
        emulatorName: string,
        writable = false,
        waitForBoot = true
    ): Promise<number> {
        let resolvedEmulatorName = emulatorName;
        return AndroidUtils.resolveEmulatorImage(emulatorName)
            .then((resolvedEmulator) => {
                // This shouldn't happen b/c we make sure an emulator exists
                // before calling this method, but keeping it just in case
                if (resolvedEmulator === undefined) {
                    return Promise.reject(
                        new SfdxError(`Invalid emulator: ${emulatorName}`)
                    );
                }
                resolvedEmulatorName = resolvedEmulator;
                return AndroidUtils.emulatorHasPort(resolvedEmulator);
            })
            .then(async (port) => {
                const resolvedPortNumber = port
                    ? port
                    : await AndroidUtils.getNextAvailableAdbPort();

                if (resolvedPortNumber === port) {
                    // already is running on a port
                    const isWritable =
                        await AndroidUtils.isEmulatorSystemWritable(
                            resolvedPortNumber
                        );

                    if (writable === false || isWritable === true) {
                        // If we're not asked for a writable, or if it already
                        // is writable then we're done so just return its port.
                        return Promise.resolve(resolvedPortNumber);
                    }

                    // mismatch... shut it down and relaunch it in the right mode
                    CommonUtils.updateCliAction(
                        messages.getMessage('notWritableSystemShutDownStatus')
                    );
                    await AndroidUtils.stopEmulator(resolvedPortNumber);
                }

                let msg = '';
                if (resolvedPortNumber === port) {
                    msg = writable
                        ? messages.getMessage('emulatorRelaunchWritableStatus')
                        : messages.getMessage(
                              'emulatorRelaunchNotWritableStatus'
                          );
                } else {
                    msg = writable
                        ? messages.getMessage('emulatorLaunchWritableStatus')
                        : messages.getMessage(
                              'emulatorLaunchNotWritableStatus'
                          );
                }

                CommonUtils.updateCliAction(
                    util.format(msg, resolvedEmulatorName, resolvedPortNumber)
                );

                // We intentionally use spawn and ignore stdio here b/c emulator command can
                // spit out a bunch of output to stderr where they are not really errors. This
                // is specially true on Windows platform. So instead we spawn the process to launch
                // the emulator and later attempt at polling the emulator to see if it failed to boot.
                const child = childProcess.spawn(
                    `${AndroidUtils.getEmulatorCommand()} @${resolvedEmulatorName} -port ${resolvedPortNumber}${
                        writable ? ' -writable-system' : ''
                    }`,
                    { detached: true, shell: true, stdio: 'ignore' }
                );
                child.unref();

                if (waitForBoot) {
                    CommonUtils.updateCliAction(
                        util.format(
                            messages.getMessage('waitForBootStatus'),
                            resolvedEmulatorName
                        )
                    );
                    await AndroidUtils.waitUntilDeviceIsReady(
                        resolvedPortNumber
                    );
                }

                return Promise.resolve(resolvedPortNumber);
            });
    }

    /**
     * Attempts to power off an emulator.
     *
     * @param portNumber The ADB port of the emulator.
     * @param waitForPowerOff Optional boolean indicating whether it should wait for the device to shut down. Defaults to true.
     */
    public static async stopEmulator(
        portNumber: number,
        waitForPowerOff = true
    ): Promise<void> {
        return AndroidUtils.executeAdbCommand(
            'shell reboot -p',
            portNumber
        ).then(() => {
            if (waitForPowerOff) {
                return AndroidUtils.waitUntilDeviceIsPoweredOff(portNumber);
            } else {
                return Promise.resolve();
            }
        });
    }

    /**
     * Attempts to reboot an emulator.
     *
     * @param portNumber The ADB port of the emulator.
     * @param waitForBoot Optional boolean indicating whether it should wait for the device to boot up. Defaults to true.
     */
    public static async rebootEmulator(
        portNumber: number,
        waitForBoot = true
    ): Promise<void> {
        return AndroidUtils.executeAdbCommand('shell reboot', portNumber).then(
            () => {
                if (waitForBoot) {
                    return AndroidUtils.waitUntilDeviceIsReady(portNumber);
                } else {
                    return Promise.resolve();
                }
            }
        );
    }

    /**
     * Determines if an emulator was launched with -writable-system parameter by looking at its emu-launch-params.txt file.
     *
     * @param portNumber The ADB port of the Android virtual device.
     * @returns A boolean indicating whether the emulator on the given port was launched with -writable-system parameter
     */
    public static async isEmulatorSystemWritable(
        portNumber: number
    ): Promise<boolean> {
        try {
            const emuPath = (
                await AndroidUtils.executeAdbCommand('emu avd path', portNumber)
            )
                .split('\n')[0]
                .trim();

            const paramFile = path.join(emuPath, 'emu-launch-params.txt');

            const launchParams = fs.readFileSync(paramFile, 'utf8');
            return Promise.resolve(launchParams.includes('-writable-system'));
        } catch (error) {
            this.logger.warn(
                `Unable to determine if emulator is system writable: ${error}`
            );
        }

        return Promise.resolve(false);
    }

    /**
     * Given an emulator that is running on a port, it returns the name of the AVD that is running on that port.
     *
     * @param portNumber The ADB port of the Android virtual device.
     * @returns The name of the AVD that is running on that specified port.
     */
    public static async fetchEmulatorNameFromPort(
        portNumber: number
    ): Promise<string> {
        return AndroidUtils.executeAdbCommand('emu avd name', portNumber).then(
            (result) => result.split('\n')[0].trim()
        );
    }

    /**
     * Mounts adb as root with writable system access for the AVD that is running on the specified port. If the AVD currently
     * is not launched with writable system access, this function will restart it with write access first then remounts as root.
     *
     * @param emulatorName Name of the emulator to be launched (e.g Pixel XL, Nexus_6_API_30).
     * @returns The ADB port that the emulator was launched on with writable access.
     */
    public static async mountAsRootWritableSystem(
        emulatorName: string
    ): Promise<number> {
        let portNumber = 0;

        // First attempt to start the emulator with writable system. Since it is already running, startEmulator() will check
        // to see if it is also running with writable system already or not. If so then nothing will happen and startEmulator()
        // will just return. Otherwise startEmulator() will power off the emulator first, then relaunch it with writable system,
        // and finally wait for it to finish booting.
        return AndroidUtils.startEmulator(emulatorName, true, true)
            .then((port) => {
                portNumber = port;
                // Now that emulator is launched with writable system, run root command
                return AndroidUtils.executeAdbCommandWithRetry(
                    'root',
                    portNumber
                );
            })
            .then(async () => {
                const emulator = await AndroidUtils.fetchEmulator(emulatorName);
                if (!emulator) {
                    return Promise.reject(
                        new SfdxError(
                            `Unable to determine device info: Port = ${portNumber} , Name = ${emulatorName}`
                        )
                    );
                }

                // For API 29 or higher there are a few more steps to be done before we can remount after rooting
                if (emulator.apiLevel.sameOrNewer(Version.from('29'))) {
                    const verificationIsAlreadyDisabled = (
                        await AndroidUtils.executeAdbCommandWithRetry(
                            'shell avbctl get-verification',
                            portNumber
                        )
                    ).includes('disabled');

                    const verityIsAlreadyDisabled = (
                        await AndroidUtils.executeAdbCommandWithRetry(
                            'shell avbctl get-verity',
                            portNumber
                        )
                    ).includes('disabled');

                    if (
                        !verificationIsAlreadyDisabled ||
                        !verityIsAlreadyDisabled
                    ) {
                        CommonUtils.updateCliAction(
                            messages.getMessage('disableAVBVerityStatus')
                        );
                    }

                    if (!verificationIsAlreadyDisabled) {
                        // Disable Android Verified Boot
                        await AndroidUtils.executeAdbCommandWithRetry(
                            'shell avbctl disable-verification',
                            portNumber
                        );
                    }

                    if (!verityIsAlreadyDisabled) {
                        // Disable Verity
                        await AndroidUtils.executeAdbCommandWithRetry(
                            'disable-verity',
                            portNumber
                        );
                    }

                    // If AVB and Verify were not disabled already and we had to run
                    // commands to disable them, then reboot for changes to take effect.
                    if (
                        !verificationIsAlreadyDisabled ||
                        !verityIsAlreadyDisabled
                    ) {
                        CommonUtils.updateCliAction(
                            messages.getMessage('rebootChangesStatus')
                        );

                        // Reboot for changes to take effect
                        await AndroidUtils.rebootEmulator(portNumber, true);

                        // Root again
                        await AndroidUtils.executeAdbCommandWithRetry(
                            'root',
                            portNumber
                        );
                    }
                }

                return Promise.resolve();
            })
            .then(() => {
                CommonUtils.updateCliAction(
                    messages.getMessage('remountSystemWritableStatus')
                );
                // Now we're ready to remount and truly have root & writable access to system
                return AndroidUtils.executeAdbCommandWithRetry(
                    'remount',
                    portNumber
                );
            })
            .then(() => Promise.resolve(portNumber));
    }

    /**
     * Attempts to wait for an Android virtual device to finish booting on an ADB port.
     *
     * @param portNumber The ADB port of the Android virtual device.
     */
    public static async waitUntilDeviceIsReady(
        portNumber: number
    ): Promise<void> {
        const quote = process.platform === WINDOWS_OS ? '"' : "'";
        const command = `wait-for-device shell ${quote}while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done;${quote}`;
        const timeout = PlatformConfig.androidConfig().deviceReadinessWaitTime;

        const waitUntilReadyPromise = CommonUtils.promiseWithTimeout(
            timeout,
            AndroidUtils.executeAdbCommand(command, portNumber),
            util.format(
                messages.getMessage('bootTimeOut'),
                `emulator-${portNumber}`
            )
        );

        return waitUntilReadyPromise.then(() => Promise.resolve());
    }

    /**
     * Attempts to wait for an Android virtual device to power off. It determines whether a device is powered off
     * by continuously running 'adb devices' command and see if this particular device is no longer in the list.
     *
     * @param portNumber The ADB port of the Android virtual device.
     */
    public static async waitUntilDeviceIsPoweredOff(
        portNumber: number
    ): Promise<void> {
        const command =
            process.platform === WINDOWS_OS
                ? `powershell -Command "while($(adb devices | findstr emulator-${portNumber})){ Start-Sleep -s 1 }"`
                : `while [[ -n $(adb devices | grep emulator-${portNumber}) ]]; do sleep 1; done;`;
        const timeout = PlatformConfig.androidConfig().deviceReadinessWaitTime;

        const waitUntilReadyPromise = CommonUtils.promiseWithTimeout(
            timeout,
            CommonUtils.executeCommandAsync(command),
            util.format(
                messages.getMessage('powerOffTimeOut'),
                `emulator-${portNumber}`
            )
        );

        return waitUntilReadyPromise.then(() => {
            // It may often be the case that the device is removed from 'adb devices' list too quickly
            // specially on Windows platform. So we also wait an extra 5 seconds.
            return CommonUtils.delay(5000);
        });
    }

    /**
     * Attempts to execute an ADB command on an Android virtual device.
     *
     * @param command The command to be executed. This should not include 'adb' command itself.
     * @param portNumber The ADB port of the Android virtual device.
     */
    public static async executeAdbCommand(
        command: string,
        portNumber: number
    ): Promise<string> {
        return AndroidUtils.executeAdbCommandWithRetry(command, portNumber, 0);
    }

    /**
     * Attempts to execute an ADB command on an Android virtual device, and will retry the command if it fails.
     *
     * @param command The command to be executed. This should not include 'adb' command itself.
     * @param portNumber The ADB port of the Android virtual device.
     * @param numRetries Optional parameter that indicates the number of times the command will be executed again if ADB comes back with an error. Defaults to AndroidConfig.AdbNumRetryAttempts.
     * @param retryDelay Optional parameter that indicates the milliseconds of delay before retrying again. Defaults to AndroidConfig.AdbRetryAttemptDelay.
     */
    public static async executeAdbCommandWithRetry(
        command: string,
        portNumber: number,
        numRetries: number = PlatformConfig.androidConfig().AdbNumRetryAttempts,
        retryDelay: number = PlatformConfig.androidConfig().AdbRetryAttemptDelay
    ): Promise<string> {
        const adbCmd = `${AndroidUtils.getAdbShellCommand()} -s emulator-${portNumber} ${command}`;

        let allOutput = '';

        for (let i = 0; i <= numRetries; i++) {
            let result: { stdout: string; stderr: string } = {
                stdout: '',
                stderr: ''
            };
            let err: any;

            try {
                result = await CommonUtils.executeCommandAsync(adbCmd);
            } catch (error) {
                err = error;
            }

            allOutput =
                (err ? err : '') +
                (result.stderr ? '\n' + result.stderr : '') +
                (result.stdout ? '\n' + result.stdout : '');

            // ADB is terrible and in addition to actual errors it may also send warnings or even success messages to stderr.
            // For example if you run the command 'adb shell reboot -p' to power down a device, when done it prints the success
            // message 'Done\n' to stderr. And sometimes ADB prints error messages to stdout instead of stderr. So we first gether
            // all outputs into one and then explicitly check to see if an error has occurred or not.
            if (allOutput && allOutput.toLowerCase().includes('error:')) {
                this.logger.warn(
                    `ADB command '${adbCmd}' failed. Retrying ${
                        numRetries - i
                    } more times.\n${result.stderr}\n${result.stdout}`
                );
                if (i < numRetries) {
                    // If we still have more retries left, delay and retry
                    await CommonUtils.delay(retryDelay);
                }
            } else {
                return Promise.resolve(result.stdout);
            }
        }

        // If we got here then it means that the command failed to execute successfully after all retries (if any)
        return Promise.reject(new SfdxError(allOutput));
    }

    /**
     * Attempts to launch a URL in the emulator browser.
     *
     * @param url The URL to be launched.
     * @param portNumber The ADB port of an Android virtual device.
     */
    public static async launchURLIntent(
        url: string,
        portNumber: number
    ): Promise<void> {
        const openUrlCommand = `shell am start -a android.intent.action.VIEW -d ${url}`;
        CommonUtils.startCliAction(
            messages.getMessage('launchBrowserAction'),
            util.format(messages.getMessage('openBrowserWithUrlStatus'), url)
        );
        return AndroidUtils.executeAdbCommand(openUrlCommand, portNumber).then(
            () => Promise.resolve()
        );
    }

    /**
     * Attempts to launch a native app in an emulator to preview LWC components. If the app is not installed then this method will attempt to install it first.
     *
     * @param compName Name of the LWC component.
     * @param projectDir Path to the LWC project root directory.
     * @param appBundlePath Optional path to the app bundle of the native app. This will be used to install the app if not already installed.
     * @param targetApp The bundle ID of the app to be launched.
     * @param targetAppArguments Extra arguments to be passed to the app upon launch.
     * @param launchActivity Activity name to be used for launching the app.
     * @param portNumber The ADB port of an Android virtual device.
     * @param serverAddress Optional address for the server that is serving the LWC component. This will be passed to the app as an extra argument upon launch.
     * @param serverPort Optional port for the server that is serving the LWC component. This will be passed to the app as an extra argument upon launch.
     */
    public static async launchNativeApp(
        compName: string,
        projectDir: string,
        appBundlePath: string | undefined,
        targetApp: string,
        targetAppArguments: LaunchArgument[],
        launchActivity: string,
        portNumber: number,
        serverAddress: string | undefined,
        serverPort: string | undefined
    ): Promise<void> {
        let thePromise: Promise<string>;
        if (appBundlePath && appBundlePath.trim().length > 0) {
            const installMsg = util.format(
                messages.getMessage('installAppStatus'),
                appBundlePath.trim()
            );
            AndroidUtils.logger.info(installMsg);
            CommonUtils.startCliAction(
                messages.getMessage('launchAppAction'),
                installMsg
            );
            const pathQuote = process.platform === WINDOWS_OS ? '"' : "'";
            const installCommand = `install -r -t ${pathQuote}${appBundlePath.trim()}${pathQuote}`;
            thePromise = AndroidUtils.executeAdbCommand(
                installCommand,
                portNumber
            );
        } else {
            thePromise = Promise.resolve('');
        }

        return thePromise
            .then(() => {
                let launchArgs =
                    `--es "${PreviewUtils.COMPONENT_NAME_ARG_PREFIX}" "${compName}"` +
                    ` --es "${PreviewUtils.PROJECT_DIR_ARG_PREFIX}" "${projectDir}"`;

                if (serverAddress) {
                    launchArgs += ` --es "${PreviewUtils.SERVER_ADDRESS_PREFIX}" "${serverAddress}"`;
                }

                if (serverPort) {
                    launchArgs += ` --es "${PreviewUtils.SERVER_PORT_PREFIX}" "${serverPort}"`;
                }

                targetAppArguments.forEach((arg) => {
                    launchArgs += ` --es "${arg.name}" "${arg.value}"`;
                });

                const launchCommand =
                    `shell am start -S -n "${targetApp}/${launchActivity}"` +
                    ' -a android.intent.action.MAIN' +
                    ' -c android.intent.category.LAUNCHER' +
                    ` ${launchArgs}`;

                const launchMsg = util.format(
                    messages.getMessage('launchAppStatus'),
                    targetApp
                );
                AndroidUtils.logger.info(launchMsg);
                CommonUtils.updateCliAction(launchMsg);

                return AndroidUtils.executeAdbCommand(
                    launchCommand,
                    portNumber
                );
            })
            .then(() => Promise.resolve());
    }

    // This method is public for testing purposes.
    public static async updateEmulatorConfig(
        emulatorName: string
    ): Promise<void> {
        return AndroidUtils.readEmulatorConfig(emulatorName).then((config) => {
            if (config.size === 0) {
                // If we cannot edit the AVD config, fail silently.
                // This will be a degraded experience but should still work.
                return Promise.resolve();
            }

            // Ensure value for runtime.network.latency is in lowercase.
            // Otherwise the device may not be able to launch via AVD Manager.
            const networkLatency = config.get('runtime.network.latency');
            if (networkLatency) {
                config.set(
                    'runtime.network.latency',
                    networkLatency.trim().toLocaleLowerCase()
                );
            }

            // Ensure value for runtime.network.speed is in lowercase.
            // Otherwise the device may not be able to launch via AVD Manager.
            const networkSpeed = config.get('runtime.network.speed');
            if (networkSpeed) {
                config.set(
                    'runtime.network.speed',
                    networkSpeed.trim().toLocaleLowerCase()
                );
            }

            // Utilize hardware.
            config.set('hw.keyboard', 'yes');
            config.set('hw.gpu.mode', 'auto');
            config.set('hw.gpu.enabled', 'yes');

            // Give emulator the appropriate skin.
            let skinName = config.get('hw.device.name') || '';
            if (skinName) {
                if (skinName === 'pixel') {
                    skinName = 'pixel_silver';
                } else if (skinName === 'pixel_xl') {
                    skinName = 'pixel_xl_silver';
                }
                const sdkRoot = AndroidUtils.getAndroidSdkRoot();
                config.set('skin.name', skinName);
                config.set(
                    'skin.path',
                    `${
                        (sdkRoot && sdkRoot.rootLocation) || ''
                    }/skins/${skinName}`
                );
                config.set('skin.dynamic', 'yes');
                config.set('showDeviceFrame', 'yes');
            }

            AndroidUtils.writeEmulatorConfig(emulatorName, config);
            return Promise.resolve();
        });
    }

    /**
     * Attempts to get the path to Android platform tools directory.
     *
     * @returns The path to Android platform tools directory.
     */
    public static getAndroidPlatformTools(): string {
        if (!AndroidUtils.androidPlatformTools) {
            const sdkRoot = AndroidUtils.getAndroidSdkRoot();
            AndroidUtils.androidPlatformTools = path.join(
                (sdkRoot && sdkRoot.rootLocation) || '',
                'platform-tools'
            );
        }

        return AndroidUtils.androidPlatformTools;
    }

    /**
     * Attempts to determine the root directory path for Android SDK. It will first look for
     * ANDROID_HOME environment variable. If it exists and point to a valid directory then
     * its value is used. Otherwise it falls back to using ANDROID_SDK_ROOT environment variable.
     *
     * @returns The root directory path for Android SDK.
     */
    public static getAndroidSdkRoot(): AndroidSDKRoot | undefined {
        if (!AndroidUtils.sdkRoot) {
            const home =
                process.env.ANDROID_HOME && process.env.ANDROID_HOME.trim();

            const root =
                process.env.ANDROID_SDK_ROOT &&
                process.env.ANDROID_SDK_ROOT.trim();

            if (home && fs.existsSync(home)) {
                AndroidUtils.sdkRoot = {
                    rootLocation: home,
                    rootSource: AndroidSDKRootSource.androidHome
                };
            } else if (root && fs.existsSync(root)) {
                AndroidUtils.sdkRoot = {
                    rootLocation: root,
                    rootSource: AndroidSDKRootSource.androidSDKRoot
                };
            }
        }

        return AndroidUtils.sdkRoot;
    }

    /**
     * Attempts to get the path to Android command line tools BIN directory. If multiple versions
     * of the command line tool are present, it will attempt to pick the latest version.
     *
     * @returns The path to Android command line tools BIN directory.
     */
    public static getAndroidCmdLineToolsBin(): string {
        if (!AndroidUtils.androidCmdLineToolsBin) {
            const sdkRoot = AndroidUtils.getAndroidSdkRoot();
            AndroidUtils.androidCmdLineToolsBin = path.join(
                (sdkRoot && sdkRoot.rootLocation) || '',
                'cmdline-tools'
            );

            // It is possible to install various versions of the command line tools side-by-side
            // In this case the directory structure would be based on tool versions:
            //
            //    cmdline-tools/1.0/bin
            //    cmdline-tools/2.1/bin
            //    cmdline-tools/3.0/bin
            //    cmdline-tools/4.0-beta01/bin
            //    cmdline-tools/latest/bin
            //
            // Below, we get the list of all directories, then sort them descending and grab the first one.
            // This would either resolve to 'latest' or the latest versioned folder name
            if (fs.existsSync(AndroidUtils.androidCmdLineToolsBin)) {
                const content = fs.readdirSync(
                    AndroidUtils.androidCmdLineToolsBin
                );
                if (content && content.length > 0) {
                    content.sort((a, b) => (a > b ? -1 : 1));

                    AndroidUtils.androidCmdLineToolsBin = path.join(
                        AndroidUtils.androidCmdLineToolsBin,
                        content[0],
                        'bin'
                    );
                }
            }
        }

        return AndroidUtils.androidCmdLineToolsBin;
    }

    /**
     * Attempts to get the path to the emulator command executable.
     *
     * @returns The path to the emulator command executable.
     */
    public static getEmulatorCommand(): string {
        if (!AndroidUtils.emulatorCommand) {
            const sdkRoot = AndroidUtils.getAndroidSdkRoot();
            AndroidUtils.emulatorCommand = path.join(
                (sdkRoot && sdkRoot.rootLocation) || '',
                'emulator',
                'emulator'
            );
        }

        return AndroidUtils.emulatorCommand;
    }

    /**
     * Attempts to get the path to the AVD manager command executable.
     *
     * @returns The path to the AVD manager command executable.
     */
    public static getAvdManagerCommand(): string {
        if (!AndroidUtils.avdManagerCommand) {
            AndroidUtils.avdManagerCommand = path.join(
                AndroidUtils.getAndroidCmdLineToolsBin(),
                ANDROID_AVD_MANAGER_NAME
            );
        }

        return AndroidUtils.avdManagerCommand;
    }

    /**
     * Attempts to get the path to the ADB command executable.
     *
     * @returns The path to the ADB command executable.
     */
    public static getAdbShellCommand(): string {
        if (!AndroidUtils.adbShellCommand) {
            AndroidUtils.adbShellCommand = path.join(
                AndroidUtils.getAndroidPlatformTools(),
                ANDROID_ADB_NAME
            );
        }

        return AndroidUtils.adbShellCommand;
    }

    /**
     * Attempts to get the path to the SDKMANAGER command executable.
     *
     * @returns The path to the SDKMANAGER command executable.
     */
    public static getSdkManagerCommand(): string {
        if (!AndroidUtils.sdkManagerCommand) {
            AndroidUtils.sdkManagerCommand = path.join(
                AndroidUtils.getAndroidCmdLineToolsBin(),
                ANDROID_SDK_MANAGER_NAME
            );
        }

        return AndroidUtils.sdkManagerCommand;
    }

    /**
     * Given an emulator name, this method checks to see if it is targeting Google Play or not.
     * If not then the method resolves otherwise it will reject.
     */
    public static async ensureDeviceIsNotGooglePlay(
        emulatorName: string
    ): Promise<void> {
        return AndroidUtils.fetchEmulator(emulatorName).then((device) => {
            if (!device) {
                return Promise.reject(
                    new SfdxError(`Device ${emulatorName} not found.`)
                );
            } else if (device.target.toLowerCase().includes('play')) {
                return Promise.reject(
                    new SfdxError(
                        'Devices targeting Google Play are not supported. Please use a device that is targeting Google APIs instead.'
                    )
                );
            } else {
                return Promise.resolve();
            }
        });
    }

    private static logger: Logger = new Logger(LOGGER_NAME);
    private static packageCache: AndroidPackages = new AndroidPackages();
    private static emulatorCommand: string | undefined;
    private static androidCmdLineToolsBin: string | undefined;
    private static androidPlatformTools: string | undefined;
    private static avdManagerCommand: string | undefined;
    private static adbShellCommand: string | undefined;
    private static sdkManagerCommand: string | undefined;
    private static sdkRoot: AndroidSDKRoot | undefined;

    private static async emulatorHasPort(
        emulatorName: string
    ): Promise<number | null> {
        try {
            const ports = await AndroidUtils.getAllCurrentlyUsedAdbPorts();
            for (const port of ports) {
                const name = await AndroidUtils.fetchEmulatorNameFromPort(port);
                if (name === emulatorName) {
                    return port;
                }
            }
        } catch (error) {
            this.logger.warn(
                `Unable to determine if emulator is already running: ${error}`
            );
        }

        return null;
    }

    private static async getNextAvailableAdbPort(): Promise<number> {
        return AndroidUtils.getAllCurrentlyUsedAdbPorts().then((ports) => {
            const adbPort =
                ports.length > 0
                    ? ports.sort().reverse()[0] + 2 // need to incr by 2, one for console port and next for adb
                    : PlatformConfig.androidConfig().defaultAdbPort;

            return Promise.resolve(adbPort);
        });
    }

    private static async getAllCurrentlyUsedAdbPorts(): Promise<number[]> {
        let ports: number[] = [];
        const command = `${AndroidUtils.getAdbShellCommand()} devices`;
        return CommonUtils.executeCommandAsync(command).then((result) => {
            if (result.stdout) {
                ports = result.stdout
                    .split('\n')
                    .filter((avd: string) =>
                        avd.toLowerCase().startsWith('emulator')
                    )
                    .map((value) => {
                        const array = value.match(/\d+/);
                        const portNumbers = array ? array.map(Number) : [0];
                        return portNumbers[0];
                    });
            }
            return Promise.resolve(ports);
        });
    }

    private static async packageWithRequiredEmulatorImages(
        androidPackage: AndroidPackage
    ): Promise<AndroidPackage | undefined> {
        const installedSystemImages =
            await AndroidUtils.fetchInstalledSystemImages();
        const platformAPI = androidPackage.platformAPI;

        for (const architecture of PlatformConfig.androidConfig()
            .supportedArchitectures) {
            for (const image of PlatformConfig.androidConfig()
                .supportedImages) {
                for (const img of installedSystemImages) {
                    if (
                        img.path.match(
                            `(${platformAPI};${image};${architecture})`
                        ) !== null
                    ) {
                        return Promise.resolve(img);
                    }
                }
            }
        }

        return Promise.resolve(undefined);
    }

    private static systemImagePath(
        platformAPI: string,
        emuImage: string,
        abi: string
    ): string {
        const pathName = `system-images;${platformAPI};${emuImage};${abi}`;
        if (process.platform === WINDOWS_OS) {
            return pathName;
        }
        return `'${pathName}'`;
    }

    private static async fetchInstalledSystemImages(): Promise<
        AndroidPackage[]
    > {
        return AndroidUtils.fetchInstalledPackages().then(
            (packages) => packages.systemImages
        );
    }

    // NOTE: detaching a process in windows seems to detach the streams. Prevent spawn from detaching when
    // used in Windows OS for special handling of some commands (adb).
    private static spawnChild(
        command: string
    ): childProcess.ChildProcessWithoutNullStreams {
        if (process.platform === WINDOWS_OS) {
            const child = childProcess.spawn(command, { shell: true });
            return child;
        } else {
            const child = childProcess.spawn(command, {
                shell: true,
                detached: true
            });
            child.unref();
            return child;
        }
    }

    // The user can provide us with emulator name as an ID (Pixel_XL) or as display name (Pixel XL).
    // This method can be used to resolve a display name back to an id since emulator commands
    // work with IDs not display names.
    private static async resolveEmulatorImage(
        emulatorName: string
    ): Promise<string | undefined> {
        const emulatorDisplayName = emulatorName.replace(/[_-]/gi, ' ').trim(); // eg. Pixel_XL --> Pixel XL, tv-emulator --> tv emulator

        return CommonUtils.executeCommandAsync(
            `${AndroidUtils.getEmulatorCommand()} -list-avds`
        )
            .then((result) => {
                const listOfAVDs = result.stdout.split('\n');
                for (const avd of listOfAVDs) {
                    const avdDisplayName = avd.replace(/[_-]/gi, ' ').trim();

                    if (
                        avd === emulatorName ||
                        avdDisplayName === emulatorDisplayName
                    ) {
                        return Promise.resolve(avd.trim());
                    }
                }
                return Promise.resolve(undefined);
            })
            .catch((error) => {
                AndroidUtils.logger.error(error);
                return Promise.resolve(undefined);
            });
    }

    private static async readEmulatorConfig(
        emulatorName: string
    ): Promise<Map<string, string>> {
        const filePath = CommonUtils.resolveUserHomePath(
            path.join(
                `~`,
                '.android',
                'avd',
                `${emulatorName}.avd`,
                'config.ini'
            )
        );
        try {
            const configFile = fs.readFileSync(filePath, 'utf8');
            const configMap = new Map();
            for (const line of configFile.split('\n')) {
                const config = line.split('=');
                if (config.length > 1) {
                    configMap.set(config[0], config[1]);
                }
            }

            return configMap;
        } catch (error) {
            AndroidUtils.logger.warn(
                `Unable to read emulator config ${filePath}: ${error}`
            );
            return new Map<string, string>();
        }
    }

    private static writeEmulatorConfig(
        emulatorName: string,
        config: Map<string, string>
    ): void {
        let configString = '';
        // This looks wrong, but the callback signature of forEach is function(value,key,map).
        config.forEach((value, key) => {
            configString += key + '=' + value + '\n';
        });
        const filePath = CommonUtils.resolveUserHomePath(
            path.join(
                `~`,
                '.android',
                'avd',
                `${emulatorName}.avd`,
                'config.ini'
            )
        );
        try {
            fs.writeFileSync(filePath, configString, 'utf8');
        } catch (error) {
            // If we cannot edit the AVD config, fail silently.
            // This will be a degraded experience but should still work.
            AndroidUtils.logger.warn(
                `Unable to write emulator config to ${filePath}: ${error}`
            );
        }
    }
}
