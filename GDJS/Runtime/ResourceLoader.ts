/*
 * GDevelop JS Platform
 * Copyright 2013-2023 Florian Rival (Florian.Rival@gmail.com). All rights reserved.
 * This project is released under the MIT License.
 */
namespace gdjs {
  const logger = new gdjs.Logger('ResourceLoader');

  const addSearchParameterToUrl = (
    url: string,
    urlEncodedParameterName: string,
    urlEncodedValue: string
  ) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      // blob/data protocol does not support search parameters, which are useless anyway.
      return url;
    }

    const separator = url.indexOf('?') === -1 ? '?' : '&';
    return url + separator + urlEncodedParameterName + '=' + urlEncodedValue;
  };

  const checkIfIsGDevelopCloudBucketUrl = (url: string): boolean => {
    return (
      url.startsWith('https://project-resources.gdevelop.io/') ||
      url.startsWith('https://project-resources-dev.gdevelop.io/')
    );
  };

  /**
   * A task of pre-loading resources used by a scene.
   *
   * A Promise can't be used instead of this class because a Promise will start
   * as soon as possible. It would flood the server with downloading requests
   * and make impossible to finely tune in which order scenes are actually
   * downloaded.
   */
  class SceneLoadingTask {
    sceneName: string;
    private onProgressCallbacks: Array<(count: number, total: number) => void>;
    private onFinishCallbacks: Array<() => void>;
    private isFinished = false;

    constructor(sceneName: string) {
      this.sceneName = sceneName;
      this.onProgressCallbacks = new Array<
        (count: number, total: number) => void
      >();
      this.onFinishCallbacks = new Array<() => void>();
    }

    registerCallback(
      onFinish: () => void,
      onProgress?: (count: number, total: number) => void
    ) {
      if (this.isFinished) {
        onFinish();
        return;
      }
      this.onFinishCallbacks.push(onFinish);
      if (onProgress) {
        this.onProgressCallbacks.push(onProgress);
      }
    }

    onProgress(count: number, total: number) {
      for (const onProgress of this.onProgressCallbacks) {
        onProgress(count, total);
      }
    }

    onFinish() {
      this.isFinished = true;
      for (const onFinish of this.onFinishCallbacks) {
        onFinish();
      }
    }
  }

  /**
   * Pre-load resources of any kind needed for a game or a scene.
   */
  export class ResourceLoader {
    _runtimeGame: RuntimeGame;
    /**
     * All the resource of a game by resource name.
     */
    private _resources: Map<string, ResourceData>;
    /**
     * Resources needed for any scene. Typically, they are resources from
     * global objects.
     */
    private _globalResources: Array<string>;
    /**
     * Resources by scene names.
     */
    private _sceneResources: Map<string, Array<string>>;
    /**
     * Keep track of which scene whose resources has already be pre-loaded.
     */
    private _sceneNamesToLoad: Set<string>;
    /**
     * Keep track of which scene whose resources has already be loaded.
     */
    private _sceneNamesToMakeReady: Set<string>;
    /**
     * A queue of scenes whose resources are still to be pre-loaded.
     */
    private _sceneToLoadQueue: Array<SceneLoadingTask> = new Array<
      SceneLoadingTask
    >();
    /**
     * The resource managers that actually download and remember downloaded
     * content.
     */
    _resourceManagersMap: Map<ResourceKind, ResourceManager>;
    private _imageManager: ImageManager;
    private _soundManager: SoundManager;
    private _fontManager: FontManager;
    private _jsonManager: JsonManager;
    private _model3DManager: Model3DManager;
    private _bitmapFontManager: BitmapFontManager;

    /**
     * Only used by events.
     */
    private currentLoadingSceneName: string = '';
    /**
     * Only used by events.
     */
    private currentSceneLoadingProgress: float = 0;

    /**
     * @param runtimeGame The game.
     * @param resourceDataArray The resources data of the game.
     * @param globalResources The resources needed for any layer.
     * @param layoutDataArray The resources used by each layer.
     */
    constructor(
      runtimeGame: RuntimeGame,
      resourceDataArray: ResourceData[],
      globalResources: Array<string>,
      layoutDataArray: Array<LayoutData>
    ) {
      this._runtimeGame = runtimeGame;
      this._resources = new Map<string, ResourceData>();
      this._globalResources = globalResources;

      // These 3 attributes are filled by `setResources`.
      this._sceneResources = new Map<string, Array<string>>();
      this._sceneNamesToLoad = new Set<string>();
      this._sceneNamesToMakeReady = new Set<string>();
      this.setResources(resourceDataArray, globalResources, layoutDataArray);

      this._imageManager = new gdjs.ImageManager(this);
      this._soundManager = new gdjs.SoundManager(this);
      this._fontManager = new gdjs.FontManager(this);
      this._jsonManager = new gdjs.JsonManager(this);
      this._bitmapFontManager = new gdjs.BitmapFontManager(
        this,
        this._imageManager
      );
      this._model3DManager = new gdjs.Model3DManager(this);

      const resourceManagers: Array<ResourceManager> = [
        this._imageManager,
        this._soundManager,
        this._fontManager,
        this._jsonManager,
        this._bitmapFontManager,
        this._model3DManager,
      ];
      this._resourceManagersMap = new Map<ResourceKind, ResourceManager>();
      for (const resourceManager of resourceManagers) {
        for (const resourceKind of resourceManager.getResourceKinds()) {
          this._resourceManagersMap.set(resourceKind, resourceManager);
        }
      }
    }

    /**
     * Update the resources data of the game. Useful for hot-reloading, should
     * not be used otherwise.
     */
    setResources(
      resourceDataArray: ResourceData[],
      globalResources: Array<string>,
      layoutDataArray: Array<LayoutData>
    ): void {
      this._globalResources = globalResources;

      this._sceneResources.clear();
      this._sceneNamesToLoad.clear();
      this._sceneNamesToMakeReady.clear();
      for (const layoutData of layoutDataArray) {
        this._sceneResources.set(
          layoutData.name,
          layoutData.usedResources.map((resource) => resource.name)
        );
        this._sceneNamesToLoad.add(layoutData.name);
        this._sceneNamesToMakeReady.add(layoutData.name);
      }
      // TODO Clearing the queue doesn't abort the running task, but it should
      // not matter as resource loading is really fast in preview mode.
      this._sceneToLoadQueue.length = 0;
      for (let index = layoutDataArray.length - 1; index >= 0; index--) {
        const layoutData = layoutDataArray[index];
        this._sceneToLoadQueue.push(new SceneLoadingTask(layoutData.name));
      }

      this._resources.clear();
      for (const resourceData of resourceDataArray) {
        this._resources.set(resourceData.name, resourceData);
      }
    }

    async loadAllResources(
      onProgress: (loadingCount: integer, totalCount: integer) => void
    ): Promise<void> {
      let loadedCount = 0;
      await Promise.all(
        [...this._resources.values()].map(async (resource) => {
          await this._loadResource(resource);
          await this._processResource(resource);
          loadedCount++;
          onProgress(loadedCount, this._resources.size);
        })
      );
      this._sceneNamesToLoad.clear();
      this._sceneNamesToMakeReady.clear();
    }

    /**
     * Load the resources that are needed to launch the first scene.
     */
    async loadGlobalAndFirstSceneResources(
      firstSceneName: string,
      onProgress: (count: number, total: number) => void
    ): Promise<void> {
      const sceneResources = this._sceneResources.get(firstSceneName);
      if (!sceneResources) {
        logger.warn(
          'Can\'t load resource for unknown scene: "' + firstSceneName + '".'
        );
        return;
      }
      let loadedCount = 0;
      const resources = [...this._globalResources, ...sceneResources.values()];
      await Promise.all(
        resources.map(async (resourceName) => {
          const resource = this._resources.get(resourceName);
          if (!resource) {
            logger.warn('Unable to find resource "' + resourceName + '".');
            return;
          }
          await this._loadResource(resource);
          await this._processResource(resource);
          loadedCount++;
          onProgress(loadedCount, resources.length);
        })
      );
      this._setSceneAssetsLoaded(firstSceneName);
      this._setSceneAssetsReady(firstSceneName);
    }

    /**
     * Load each scene in order.
     *
     * This is done in background to try to avoid loading screens when changing
     * scenes.
     */
    async loadAllSceneInBackground(): Promise<void> {
      while (this._sceneToLoadQueue.length > 0) {
        const task = this._sceneToLoadQueue[this._sceneToLoadQueue.length - 1];
        if (task === undefined) {
          continue;
        }
        this.currentLoadingSceneName = task.sceneName;
        if (!this.areSceneAssetsLoaded(task.sceneName)) {
          await this._doLoadSceneResources(
            task.sceneName,
            async (count, total) => task.onProgress(count, total)
          );
          // A scene may have been moved last while awaiting resources to be
          // downloaded (see _prioritizeScene).
          this._sceneToLoadQueue.splice(
            this._sceneToLoadQueue.findIndex((element) => element === task),
            1
          );
          task.onFinish();
        } else {
          this._sceneToLoadQueue.pop();
        }
      }
      this.currentLoadingSceneName = '';
    }

    private async _doLoadSceneResources(
      sceneName: string,
      onProgress?: (count: number, total: number) => Promise<void>
    ): Promise<void> {
      const sceneResources = this._sceneResources.get(sceneName);
      if (!sceneResources) {
        logger.warn(
          'Can\'t load resource for unknown scene: "' + sceneName + '".'
        );
        return;
      }
      let loadedCount = 0;
      await Promise.all(
        [...sceneResources.values()].map(async (resourceName) => {
          const resource = this._resources.get(resourceName);
          if (!resource) {
            logger.warn('Unable to find resource "' + resourceName + '".');
            return;
          }
          await this._loadResource(resource);
          loadedCount++;
          this.currentSceneLoadingProgress = loadedCount / this._resources.size;
          onProgress && (await onProgress(loadedCount, this._resources.size));
        })
      );
      this._setSceneAssetsLoaded(sceneName);
    }

    private async _loadResource(resource: ResourceData): Promise<void> {
      const resourceManager = this._resourceManagersMap.get(resource.kind);
      if (!resourceManager) {
        logger.warn(
          'Unknown resource kind: "' +
            resource.kind +
            '" for: "' +
            resource.name +
            '".'
        );
        return;
      }
      await resourceManager.loadResource(resource.name);
    }

    /**
     * Load and process a scene that is needed right away.
     *
     * The renderer will show a loading screen while its done.
     */
    async loadAndProcessSceneResources(
      sceneName: string,
      onProgress?: (count: number, total: number) => Promise<void>
    ): Promise<void> {
      if (this.areSceneAssetsReady(sceneName)) {
        return;
      }
      await this.loadSceneResources(sceneName, onProgress);

      const sceneResources = this._sceneResources.get(sceneName);
      if (!sceneResources) {
        logger.warn(
          'Can\'t load resource for unknown scene: "' + sceneName + '".'
        );
        return;
      }

      let parsedCount = 0;
      for (const resourceName of sceneResources) {
        const resource = this._resources.get(resourceName);
        if (!resource) {
          logger.warn('Unable to find resource "' + resourceName + '".');
          continue;
        }
        await this._processResource(resource);
        parsedCount++;
        onProgress && (await onProgress(parsedCount, sceneResources.length));
      }
      this._setSceneAssetsReady(sceneName);
    }

    /**
     * Load a scene resources without parsing them.
     *
     * When another scene resources are loading in background, it waits for
     * all its resources to be loaded before loading resources of the given
     * scene.
     */
    async loadSceneResources(
      sceneName: string,
      onProgress?: (count: number, total: number) => void
    ): Promise<void> {
      const task = this._prioritizeScene(sceneName);
      return new Promise<void>((resolve, reject) => {
        if (!task) {
          resolve();
          return;
        }
        task.registerCallback(() => {
          resolve();
        }, onProgress);
      });
    }

    /**
     * Put a given scene at the end of the queue.
     *
     * When the scene that is currently loading in background is done,
     * this scene will be the next to be loaded.
     */
    private _prioritizeScene(sceneName: string): SceneLoadingTask | null {
      const taskIndex = this._sceneToLoadQueue.findIndex(
        (task) => task.sceneName === sceneName
      );
      if (taskIndex < 0) {
        // The scene is already loaded.
        return null;
      }
      const task = this._sceneToLoadQueue[taskIndex];
      this._sceneToLoadQueue.splice(taskIndex, 1);
      this._sceneToLoadQueue.push(task);
      return task;
    }

    private async _processResource(resource: ResourceData): Promise<void> {
      const resourceManager = this._resourceManagersMap.get(resource.kind);
      if (!resourceManager) {
        logger.warn(
          'Unknown resource kind: "' +
            resource.kind +
            '" for: "' +
            resource.name +
            '".'
        );
        return;
      }
      await resourceManager.processResource(resource.name);
    }

    getSceneLoadingProgress(sceneName: string): float {
      return sceneName === this.currentLoadingSceneName
        ? this.currentSceneLoadingProgress
        : this.areSceneAssetsLoaded(sceneName)
        ? 1
        : 0;
    }

    /**
     * @returns true when all the resources of the given scene are loaded
     * (but maybe not parsed).
     */
    areSceneAssetsLoaded(sceneName: string): boolean {
      return !this._sceneNamesToLoad.has(sceneName);
    }

    /**
     * @returns true when all the resources of the given scene are loaded and
     * parsed.
     */
    areSceneAssetsReady(sceneName: string): boolean {
      return !this._sceneNamesToMakeReady.has(sceneName);
    }

    private _setSceneAssetsLoaded(sceneName: string): void {
      this._sceneNamesToLoad.delete(sceneName);
    }

    private _setSceneAssetsReady(sceneName: string): void {
      this._sceneNamesToMakeReady.delete(sceneName);
    }

    getResource(resourceName: string): ResourceData | null {
      return this._resources.get(resourceName) || null;
    }

    // Helper methods used when resources are loaded from an URL.

    /**
     * Complete the given URL with any specific parameter required to access
     * the resource (this can be for example a token needed to access the resource).
     */
    getFullUrl(url: string) {
      const { gdevelopResourceToken } = this._runtimeGame._options;
      if (!gdevelopResourceToken) return url;

      if (!checkIfIsGDevelopCloudBucketUrl(url)) return url;

      return addSearchParameterToUrl(
        url,
        'gd_resource_token',
        encodeURIComponent(gdevelopResourceToken)
      );
    }

    /**
     * Return true if the specified URL must be loaded with cookies ("credentials")
     * sent to grant access to them.
     */
    checkIfCredentialsRequired(url: string) {
      if (this._runtimeGame._options.gdevelopResourceToken) return false;

      // Any resource stored on the GDevelop Cloud buckets needs the "credentials" of the user,
      // i.e: its gdevelop.io cookie, to be passed.
      // Note that this is only useful during previews.
      if (checkIfIsGDevelopCloudBucketUrl(url)) return true;

      // For other resources, use the default way of loading resources ("anonymous" or "same-site").
      return false;
    }

    /**
     * Get the gdjs.SoundManager of the RuntimeGame.
     * @return The sound manager.
     */
    getSoundManager(): gdjs.HowlerSoundManager {
      return this._soundManager;
    }

    /**
     * Get the gdjs.ImageManager of the RuntimeGame.
     * @return The image manager.
     */
    getImageManager(): gdjs.PixiImageManager {
      return this._imageManager;
    }

    /**
     * Get the gdjs.FontManager of the RuntimeGame.
     * @return The font manager.
     */
    getFontManager(): gdjs.FontFaceObserverFontManager {
      return this._fontManager;
    }

    /**
     * Get the gdjs.BitmapFontManager of the RuntimeGame.
     * @return The bitmap font manager.
     */
    getBitmapFontManager(): gdjs.BitmapFontManager {
      return this._bitmapFontManager;
    }

    /**
     * Get the JSON manager of the game, used to load JSON from game
     * resources.
     * @return The json manager for the game
     */
    getJsonManager(): gdjs.JsonManager {
      return this._jsonManager;
    }

    /**
     * Get the 3D model manager of the game, used to load 3D model from game
     * resources.
     * @return The 3D model manager for the game
     */
    getModel3DManager(): gdjs.Model3DManager {
      return this._model3DManager;
    }
  }
}
