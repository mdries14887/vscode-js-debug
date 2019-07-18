// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SourceMap } from './sourceMap';
import * as utils from '../utils';
import Dap from '../dap/api';
import { URL } from 'url';
import * as path from 'path';
import * as errors from './errors';
import { prettyPrintAsSourceMap } from './prettyPrint';

// This is a ui location. Usually it corresponds to a position
// in the document user can see (Source, Dap.Source). When no source
// is available, it just holds a url to show in the ui.
export interface Location {
  lineNumber: number; // 1-based
  columnNumber: number;  // 1-based
  url: string;
  source?: Source;
};

type ContentGetter = () => Promise<string | undefined>;
type InlineScriptOffset = { lineOffset: number, columnOffset: number };
type SourceMapData = { compiled: Set<Source>, map?: SourceMap, loaded: Promise<void> };

export interface LocationRevealer {
  revealLocation(location: Location): Promise<void>;
}

export interface SourcePathResolver {
  rewriteSourceUrl(sourceUrl: string): string;
  urlToExistingAbsolutePath(url: string): Promise<string>;
  absolutePathToUrl(absolutePath: string): string | undefined;
}

export class Source {
  private static _lastSourceReference = 0;

  _sourceReference: number;
  _url: string;
  _name: string;
  _fqname: string;
  _contentGetter: ContentGetter;
  _sourceMapUrl?: string;
  _inlineScriptOffset?: InlineScriptOffset;
  _container: SourceContainer;
  _absolutePath: Promise<string>;

  // Sources generated for this compiled from it's source map. Exclusive with |_origin|.
  _sourceMapSourceByUrl?: Map<string, Source>;
  // SourceUrl (as listed in source map) for each compiled referencing this source.
  // Exclusive with |_sourceMapSourceByUrl|.
  _compiledToSourceUrl?: Map<Source, string>;

  private _content?: Promise<string | undefined>;

  constructor(container: SourceContainer, url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineScriptOffset?: InlineScriptOffset) {
    this._sourceReference = ++Source._lastSourceReference;
    this._url = url;
    this._contentGetter = contentGetter;
    this._sourceMapUrl = sourceMapUrl;
    this._inlineScriptOffset = inlineScriptOffset;
    this._container = container;
    this._fqname = this._fullyQualifiedName();
    this._name = path.basename(this._fqname);
    this._absolutePath = container._sourcePathResolver.urlToExistingAbsolutePath(url);
  }

  url(): string {
    return this._url;
  }

  sourceReference(): number {
    return this._sourceReference;
  }

  content(): Promise<string | undefined> {
    if (this._content === undefined)
      this._content = this._contentGetter();
    return this._content;
  }

  mimeType(): string {
    return 'text/javascript';
  }

  canPrettyPrint(): boolean {
    return this._container && !this._name.endsWith('-pretty.js');
  }

  async prettyPrint(): Promise<boolean> {
    if (!this._container || !this.canPrettyPrint())
      return false;
    if (this._sourceMapUrl && this._sourceMapUrl.endsWith('-pretty.map'))
      return true;
    const content = await this.content();
    if (!content)
      return false;
    const sourceMapUrl = this.url() + '-pretty.map';
    const prettyPath = this._fqname + '-pretty.js';
    const map = prettyPrintAsSourceMap(prettyPath, content);
    if (!map)
      return false;
    this._sourceMapUrl = sourceMapUrl;
    const sourceMap: SourceMapData = { compiled: new Set([this]), map, loaded: Promise.resolve() };
    this._container._sourceMaps.set(sourceMapUrl, sourceMap);
    this._container._addSourceMapSources(this, map);
    return true;
  }

  async toDap(): Promise<Dap.Source> {
    let absolutePath = await this._absolutePath;
    const sources = this._sourceMapSourceByUrl
      ? await Promise.all(Array.from(this._sourceMapSourceByUrl.values()).map(s => s.toDap()))
      : undefined;
    if (absolutePath) {
      return {
        name: this._name,
        path: absolutePath,
        sourceReference: 0,
        sources,
      };
    }
    return {
      name: this._name,
      path: this._fqname,
      sourceReference: this._sourceReference,
      sources,
    };
  }

  async absolutePath(): Promise<string | undefined> {
    return this._absolutePath;
  }

  async prettyName(): Promise<string> {
    const path = await this._absolutePath;
    if (path)
      return path;
    return this._fqname;
  }

  _fullyQualifiedName(): string {
    if (!this._url)
      return 'VM/VM' + this._sourceReference;
    let fqname = this._url;
    try {
      const tokens: string[] = [];
      const url = new URL(this._url);
      if (url.protocol === 'data:')
        return 'VM/VM' + this._sourceReference;
      if (url.hostname)
        tokens.push(url.hostname);
      if (url.port)
        tokens.push('\uA789' + url.port);  // : in unicode
      if (url.pathname)
        tokens.push(url.pathname);
      if (url.searchParams)
        tokens.push(url.searchParams.toString());
      fqname = tokens.join('');
    } catch (e) {
    }
    if (fqname.endsWith('/'))
      fqname += '(index)';
    if (this._inlineScriptOffset)
      fqname = `${fqname}\uA789${this._inlineScriptOffset.lineOffset + 1}:${this._inlineScriptOffset.columnOffset + 1}`;
    return fqname;
  }
};

export class SourceContainer {
  private _dap: Dap.Api;
  _sourcePathResolver: SourcePathResolver;

  private _sourceByReference: Map<number, Source> = new Map();
  private _compiledByUrl: Map<string, Source> = new Map();
  private _sourceMapSourcesByUrl: Map<string, Source> = new Map();
  private _sourceByAbsolutePath: Map<string, Source> = new Map();

  // All source maps by url.
  _sourceMaps: Map<string, SourceMapData> = new Map();
  private _revealer?: LocationRevealer;

  constructor(dap: Dap.Api, sourcePathResolver: SourcePathResolver) {
    this._dap = dap;
    this._sourcePathResolver = sourcePathResolver;
  }

  installRevealer(revealer: LocationRevealer) {
    this._revealer = revealer;
  }

  sources(): Source[] {
    return Array.from(this._sourceByReference.values());
  }

  source(ref: Dap.Source): Source | undefined {
    if (ref.sourceReference)
      return this._sourceByReference.get(ref.sourceReference);
    if (ref.path)
      return this._sourceByAbsolutePath.get(ref.path);
    return undefined;
  }

  sourceByUrl(url: string): Source | undefined {
    return this._compiledByUrl.get(url);
  }

  preferredLocation(location: Location): Location {
    return this._locations(location)[0];
  }

  siblingLocations(location: Location, inSource?: Source): Location[] {
    return this._locations(location).filter(location => !inSource || location.source === inSource);
  }

  _locations(location: Location): Location[] {
    const result: Location[] = [];
    this._addSourceMapLocations(location, result);
    result.push(location);
    this._addCompiledLocations(location, result);
    return result;
  }

  _addSourceMapLocations(location: Location, result: Location[]) {
    if (!location.source)
      return;
    if (!location.source._sourceMapUrl || !location.source._sourceMapSourceByUrl)
      return;
    const map = this._sourceMaps.get(location.source._sourceMapUrl)!.map;
    if (!map)
      return;

    let { lineNumber, columnNumber } = location;
    if (location.source._inlineScriptOffset) {
      lineNumber -= location.source._inlineScriptOffset.lineOffset;
      if (lineNumber === 1)
        columnNumber -= location.source._inlineScriptOffset.columnOffset;
    }
    const entry = map.findEntry(lineNumber - 1, columnNumber - 1);
    if (!entry || !entry.sourceUrl)
      return;

    const source = location.source._sourceMapSourceByUrl.get(entry.sourceUrl);
    if (!source)
      return;

    const sourceMapLocation = {
      lineNumber: (entry.sourceLineNumber || 0) + 1,
      columnNumber: (entry.sourceColumnNumber || 0) + 1,
      url: source._url,
      source: source
    };
    this._addSourceMapLocations(sourceMapLocation, result);
    result.push(sourceMapLocation);
  }

  _addCompiledLocations(location: Location, result: Location[]) {
    if (!location.source || !location.source._compiledToSourceUrl)
      return;
    for (const [compiled, sourceUrl] of location.source._compiledToSourceUrl) {
      const map = this._sourceMaps.get(compiled._sourceMapUrl!)!.map;
      if (!map)
        continue;
      const entry = map.findReverseEntry(sourceUrl, location.lineNumber - 1, location.columnNumber - 1);
      if (!entry)
        continue;
      const compiledLocation = {
        lineNumber: entry.lineNumber + 1,
        columnNumber: entry.columnNumber + 1,
        url: compiled.url(),
        source: compiled
      };
      if (compiled._inlineScriptOffset) {
        compiledLocation.lineNumber += compiled._inlineScriptOffset.lineOffset;
        if (compiledLocation.lineNumber === 1)
          compiledLocation.columnNumber += compiled._inlineScriptOffset.columnOffset;
      }
      result.push(compiledLocation);
      this._addCompiledLocations(compiledLocation, result);
    }
  }

  addSource(url: string, contentGetter: ContentGetter, sourceMapUrl?: string, inlineSourceRange?: InlineScriptOffset): Source {
    console.assert(!url || !this._compiledByUrl.has(url));
    const source = new Source(this, url, contentGetter, sourceMapUrl, inlineSourceRange);
    this._addSource(source);
    return source;
  }

  async _addSource(source: Source) {
    this._sourceByReference.set(source.sourceReference(), source);
    if (source._compiledToSourceUrl)
      this._sourceMapSourcesByUrl.set(source._url, source);
    else if (source._url)
      this._compiledByUrl.set(source._url, source);

    source._absolutePath.then(absolutePath => {
      if (absolutePath && this._sourceByReference.get(source.sourceReference()) === source)
        this._sourceByAbsolutePath.set(absolutePath, source);
    });
    source.toDap().then(payload => {
      this._dap.loadedSource({ reason: 'new', source: payload });
    });

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl)
      return;

    let sourceMap = this._sourceMaps.get(sourceMapUrl);
    if (sourceMap) {
      sourceMap.compiled.add(source);
      if (sourceMap.map) {
        // If source map has been already loaded, we add sources here.
        // Otheriwse, we'll add sources for all compiled after loading the map.
        this._addSourceMapSources(source, sourceMap.map);
      }
      return;
    }

    let callback: () => void;
    const promise = new Promise<void>(f => callback = f);
    sourceMap = { compiled: new Set([source]), loaded: promise };
    this._sourceMaps.set(sourceMapUrl, sourceMap);
    sourceMap.map = await SourceMap.load(sourceMapUrl);
    // Source map could have been detached while loading.
    if (this._sourceMaps.get(sourceMapUrl) !== sourceMap)
      return callback!();
    if (!sourceMap.map) {
      errors.reportToConsole(this._dap, `Could not load source map from ${sourceMapUrl}`);
      return callback!();
    }

    for (const error of sourceMap.map!.errors())
      errors.reportToConsole(this._dap, error);
    for (const anyCompiled of sourceMap.compiled)
      this._addSourceMapSources(anyCompiled, sourceMap.map!);
    callback!();
  }

  removeSource(source: Source) {
    console.assert(this._sourceByReference.get(source.sourceReference()) === source);
    this._sourceByReference.delete(source.sourceReference());
    if (source._compiledToSourceUrl)
      this._sourceMapSourcesByUrl.delete(source._url);
    else if (source._url)
      this._compiledByUrl.delete(source._url);

    source.absolutePath().then(absolutePath => {
      if (absolutePath && this._sourceByAbsolutePath.get(absolutePath) === source)
        this._sourceByAbsolutePath.delete(absolutePath);
    });
    source.toDap().then(payload => {
      this._dap.loadedSource({ reason: 'removed', source: payload });
    });

    const sourceMapUrl = source._sourceMapUrl;
    if (!sourceMapUrl)
      return;

    const sourceMap = this._sourceMaps.get(sourceMapUrl)!;
    console.assert(sourceMap.compiled.has(source));
    sourceMap.compiled.delete(source);
    if (!sourceMap.compiled.size)
      this._sourceMaps.delete(sourceMapUrl);
    // Source map could still be loading, or failed to load.
    if (sourceMap.map)
      this._removeSourceMapSources(source, sourceMap.map);
  }

  _addSourceMapSources(compiled: Source, map: SourceMap) {
    compiled._sourceMapSourceByUrl = new Map();
    const addedSources: Source[] = [];
    for (const url of map.sourceUrls()) {
      const sourceUrl = this._sourcePathResolver.rewriteSourceUrl(url);
      const baseUrl = map.url().startsWith('data:') ? compiled.url() : map.url();
      const resolvedUrl = utils.completeUrl(baseUrl, sourceUrl) || sourceUrl;
      const content = map.sourceContent(url);
      let source = this._sourceMapSourcesByUrl.get(resolvedUrl);
      const isNew = !source;
      if (!source) {
        // Note: we can support recursive source maps here if we parse sourceMapUrl comment.
        source = new Source(this, resolvedUrl, content !== undefined ? () => Promise.resolve(content) : () => utils.fetch(resolvedUrl));
        source._compiledToSourceUrl = new Map();
      }
      source._compiledToSourceUrl!.set(compiled, url);
      compiled._sourceMapSourceByUrl.set(url, source);
      if (isNew)
        this._addSource(source);
      addedSources.push(source);
    }
  }

  _removeSourceMapSources(compiled: Source, map: SourceMap) {
    for (const url of map.sourceUrls()) {
      const source = compiled._sourceMapSourceByUrl!.get(url)!;
      compiled._sourceMapSourceByUrl!.delete(url);
      console.assert(source._compiledToSourceUrl!.has(compiled));
      source._compiledToSourceUrl!.delete(compiled);
      if (source._compiledToSourceUrl!.size)
        continue;
      this.removeSource(source);
    }
  }

  async waitForSourceMapSources(source: Source): Promise<Source[]> {
    if (!source._sourceMapUrl)
      return [];
    const sourceMap = this._sourceMaps.get(source._sourceMapUrl)!;
    await sourceMap.loaded;
    if (!source._sourceMapSourceByUrl)
      return [];
    return Array.from(source._sourceMapSourceByUrl.values());
  }

  async revealLocation(location: Location): Promise<void> {
    if (this._revealer)
      this._revealer.revealLocation(location);
  }
};