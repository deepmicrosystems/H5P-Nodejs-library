const fs = require('fs-extra');
const glob = require('glob-promise');
const path = require('path');

const { streamToString } = require('./helpers/stream-helpers');
const Library = require('./library'); // eslint-disable-line no-unused-vars
const FileLibraryStorage = require('./file-library-storage'); // eslint-disable-line no-unused-vars

/**
 * This class manages library installations, enumerating installed libraries etc.
 * It is storage agnostic and can be re-used in all implementations/plugins.
 */

class LibraryManager {
    /**
     *
     * @param {FileLibraryStorage} libraryStorage The library repository that persists library somewhere.
     */
    constructor(libraryStorage) {
        this._libraryStorage = libraryStorage;
    }

    /**
     * Get a list of the currently installed libraries.
     * @param {String[]?} machineNames (if supplied) only return results for the machines names in the list
     * @returns {Promise<any>} An object which has properties with the existing library machine names. The properties'
     * values are arrays of Library objects, which represent the different versions installed of this library.
     */
    async getInstalled(...machineNames) {
        let libraries = await this._libraryStorage.getInstalled(
            ...machineNames
        );
        libraries = libraries.map(async oldLib => {
            const newLib = oldLib;
            const info = await this.loadLibrary(oldLib);
            newLib.patchVersion = info.patchVersion;
            newLib.id = info.libraryId;
            newLib.runnable = info.runnable;
            newLib.title = info.title;
            return newLib;
        });
        libraries = (await Promise.all(libraries)).sort((lib1, lib2) =>
            lib1.compare(lib2)
        );

        const returnObject = {};
        for (const library of libraries) {
            if (!returnObject[library.machineName]) {
                returnObject[library.machineName] = [];
            }
            returnObject[library.machineName].push(library);
        }
        return returnObject;
    }

    /**
     * Get id to an existing installed library.
     * If version number is not specified, the newest version will be returned.
     * @param {Library} library Note that patch version is ignored.
     * @returns {Promise<number>} The id of the specified library or undefined (if not installed).
     */
    async getId(library) {
        return this._libraryStorage.getId(library);
    }

    /**
     * Checks if the given library has a higher version than the highest installed version.
     * @param {Library} library Library to compare against the highest locally installed version.
     * @returns {Promise<boolean>} true if the passed library contains a version that is higher than the highest installed version, false otherwise
     */
    async libraryHasUpgrade(library) {
        const wrappedLibraryInfos = await this.getInstalled(
            library.machineName
        );
        if (
            !wrappedLibraryInfos ||
            !wrappedLibraryInfos[library.machineName] ||
            !wrappedLibraryInfos[library.machineName].length === 0
        ) {
            return false;
        }
        const allInstalledLibsOfMachineName = wrappedLibraryInfos[
            library.machineName
        ].sort((a, b) => a.compareVersions(b));
        const highestLocalLibVersion =
            allInstalledLibsOfMachineName[
                allInstalledLibsOfMachineName.length - 1
            ];
        if (highestLocalLibVersion.compareVersions(library) < 0) {
            return true;
        }
        return false;
    }

    /**
     * Returns the information about the library that is contained in library.json.
     * @param {Library} library The library to get (machineName, majorVersion and minorVersion is enough)
     * @returns {Promise<ILibrary>} the decoded JSON data or undefined if library is not installed
     */
    async loadLibrary(library) {
        try {
            const libraryMetadata = await this._getJsonFile(
                library,
                'library.json'
            );
            libraryMetadata.libraryId = await this.getId(library);
            return libraryMetadata;
        } catch (ignored) {
            return undefined;
        }
    }

    /**
     * Check if the library contains a file
     * @param {Library} library The library to check
     * @param {string} filename
     * @return {Promise<boolean>} true if file exists in library, false otherwise
     */
    async libraryFileExists(library, filename) {
        return this._libraryStorage.fileExists(library, filename);
    }

    /**
     * Is the library a patched version of an existing library?
     * @param {Library} library The library the check
     * @returns {Promise<boolean>} true if the library is a patched version of an existing library, false otherwise
     */
    async isPatchedLibrary(library) {
        const wrappedLibraryInfos = await this.getInstalled(
            library.machineName
        );
        if (!wrappedLibraryInfos || !wrappedLibraryInfos[library.machineName]) {
            return false;
        }
        const libraryInfos = wrappedLibraryInfos[library.machineName];
        for (let x = 0; x < libraryInfos.length; x += 1) {
            if (
                libraryInfos[x].majorVersion === library.majorVersion &&
                libraryInfos[x].minorVersion === library.minorVersion
            ) {
                if (libraryInfos[x].patchVersion < library.patchVersion) {
                    return true;
                }
                break;
            }
        }
        return false;
    }

    /**
     * Installs or updates a library from a temporary directory.
     * It does not delete the library files in the temporary directory.
     * The method does NOT validate the library! It must be validated before calling this method!
     * Throws an error if something went wrong and deletes the files already installed.
     * @param {string} directory The path to the temporary directory that contains the library files (the root directory that includes library.json)
     * @returns {Promise<boolean>} true if successful, false if the library was not installed (without having encountered an error, e.g. because there already is a newer patch version installed)
     */
    async installFromDirectory(directory, { restricted = false }) {
        const libraryMetadata = await fs.readJSON(`${directory}/library.json`);
        let library = Library.createFromMetadata(libraryMetadata);
        if (await this.getId(library)) {
            // Check if library is already installed.
            if (await this.isPatchedLibrary(library)) {
                // Update the library if it is only a patch of an existing library
                await this._updateLibrary(library, libraryMetadata, directory);
                return true;
            } else {
                // Skip installation of library if it has already been installed and the library is no patch for it.
                return false;
            }
        } else {
            // Install the library if it hasn't been installed before (treat different major/minor versions the same as a new library)
            library = await this._installLibrary(
                directory,
                library,
                libraryMetadata,
                restricted
            );
            return true;
        }
    }

    /**
     * Gets a list of translations that exist for this library.
     * @param {Library} library
     * @returns {Promise<string[]>} the language codes for translations of this library
     */
    async listLanguages(library) {
        try {
            return await this._libraryStorage.getLanguageFiles(library);
        } catch (error) {
            return [];
        }
    }

    /**
     * Gets the language file for the specified language.
     * @param {Library} library
     * @param {string} language the language code
     * @returns {Promise<any>} the decoded JSON data in the language file
     */
    async loadLanguage(library, language) {
        try {
            return await this._getJsonFile(
                library,
                path.join('language', `${language}.json`)
            );
        } catch (ignored) {
            return null;
        }
    }

    /**
     * Returns a readable stream of a library file's contents.
     * Throws an exception if the file does not exist.
     * @param {Library} library library
     * @param {string} filename the relative path inside the library
     * @returns {Stream} a readable stream of the file's contents
     */
    async getFileStream(library, file) {
        return this._libraryStorage.getFileStream(library, file);
    }

    /**
     * Returns the content of semantics.json for the specified library.
     * @param {Library} library
     * @returns {Promise<any>} the content of semantics.json
     */
    async loadSemantics(library) {
        return this._getJsonFile(library, 'semantics.json');
    }

    /**
     * Updates the library to a new version.
     * REMOVES THE LIBRARY IF THERE IS AN ERROR!!!
     * @param {number} installedLibraryId The id of the installed library
     * @param {string} filesDirectory the path of the directory containing the library files to update to
     * @param {Library} libraryInfo the library object
     * @param {any} libraryMetadata the library metadata (library.json)
     * @param {boolean} restricted true if the library can only be installed with a special permission
     */
    async _updateLibrary(libraryInfo, libraryMetadata, filesDirectory) {
        try {
            await this._libraryStorage.updateLibrary(
                libraryInfo,
                libraryMetadata
            );
            await this._libraryStorage.clearLibraryFiles(libraryInfo);
            await this._copyLibraryFiles(filesDirectory, libraryInfo);
            await this._checkConsistency(libraryInfo);
        } catch (error) {
            await this._libraryStorage.removeLibrary(libraryInfo);
            throw error;
        }
    }

    /**
     * Installs a library and rolls back changes if the library installation failed.
     * Throws errors if something went wrong.
     * @param {string} fromDirectory the local directory to install from
     * @param {Library} libraryInfo the library object
     * @param {any} libraryMetadata the library metadata
     * @param {boolean} restricted true if the library can only be installed with a special permission
     * @returns {Library} the libray object (containing - among others - the id of the newly installed library)
     */
    async _installLibrary(
        fromDirectory,
        libraryInfo,
        libraryMetadata,
        restricted
    ) {
        libraryInfo = await this._libraryStorage.installLibrary(
            libraryMetadata,
            { restricted }
        );
        try {
            await this._copyLibraryFiles(fromDirectory, libraryInfo);
            await this._checkConsistency(libraryInfo);
        } catch (error) {
            await this._libraryStorage.removeLibrary(libraryInfo);
            throw error;
        }
        return libraryInfo;
    }

    /**
     * Copies all library files from a directory (excludes library.json) to the storage.
     * Throws errors if something went wrong.
     * @param {string} fromDirectory The directory to copy from
     * @param {Library} libraryInfo the library object
     * @returns {Promise<void>}
     */
    async _copyLibraryFiles(fromDirectory, libraryInfo) {
        const files = await glob(`${fromDirectory}/**/*.*`);
        await Promise.all(
            files.map(fileFullPath => {
                const fileLocalPath = path.relative(
                    fromDirectory,
                    fileFullPath
                );
                if (fileLocalPath === 'library.json') {
                    return Promise.resolve();
                }
                const readStream = fs.createReadStream(fileFullPath);
                return this._libraryStorage.addLibraryFile(
                    libraryInfo,
                    fileLocalPath,
                    readStream
                );
            })
        );
    }

    /**
     * Gets the parsed contents of a library file that is JSON.
     * @param {Library} library
     * @param {string} file
     * @returns {Promise<any|undefined>} The content or undefined if there was an error
     */
    async _getJsonFile(library, file) {
        const stream = await this._libraryStorage.getFileStream(library, file);
        const jsonString = await streamToString(stream);
        return JSON.parse(jsonString);
    }

    /**
     * Checks (as far as possible) if all necessary files are present for the library to run properly.
     * @param {Library} library The library to check
     * @returns {Promise<boolean>} true if the library is ok. Throws errors if not.
     */
    async _checkConsistency(library) {
        if (!(await this._libraryStorage.getId(library))) {
            throw new Error(
                `Error in library ${library.getDirName()}: not installed.`
            );
        }

        let metadata;
        try {
            metadata = await this._getJsonFile(library, 'library.json');
        } catch (error) {
            throw new Error(
                `Error in library ${library.getDirName()}: library.json not readable: ${
                    error.message
                }.`
            );
        }
        if (metadata.preloadedJs) {
            await this._checkFiles(
                library,
                metadata.preloadedJs.map(js => js.path)
            );
        }
        if (metadata.preloadedCss) {
            await this._checkFiles(
                library,
                metadata.preloadedCss.map(css => css.path)
            );
        }

        return true;
    }

    /**
     * Checks if all files in the list are present in the library.
     * @param {Library} library The library to check
     * @param {string[]} requiredFiles The files (relative paths in the library) that must be present
     * @returns {Promise<boolean>} true if all dependencies are present. Throws an error if any are missing.
     */
    async _checkFiles(library, requiredFiles) {
        const missingFiles = (await Promise.all(
            requiredFiles.map(async file => {
                return {
                    status: await this._libraryStorage.fileExists(
                        library,
                        file
                    ),
                    path: file
                };
            })
        ))
            .filter(file => !file.status)
            .map(file => file.path);
        if (missingFiles.length > 0) {
            let message = `Error(s) in library ${library.getDirName()}:\n`;
            message += missingFiles
                .map(file => `${file} is missing.`)
                .join('\n');
            throw new Error(message);
        }
        return true;
    }
}

module.exports = LibraryManager;