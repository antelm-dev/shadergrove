import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShaderHistoryEntry, ShaderRecord } from '@shadergrove/shared/model';
import { DesktopShaderApi } from '../desktop/desktop-shader-api';
import { API_BASE_URL } from './api-base-url';
import { ApiError, HttpShaderApi } from './shader-api';

const ENTRY: ShaderHistoryEntry = {
  revision: 3,
  createdAt: '2026-10-08T10:00:00.000Z',
  cause: 'update',
  checkpointName: null,
  restoredFromRevision: null,
};
const RECORD = { id: 'waves', revision: 5 } as ShaderRecord;

/** The same three history calls reach the same contract over REST and over Electron IPC. */
describe('HttpShaderApi history', () => {
  let api: HttpShaderApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '' },
        HttpShaderApi,
      ],
    });
    api = TestBed.inject(HttpShaderApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('lists the history newest first, as the server sends it', async () => {
    const listed = api.listHistory('waves');
    const request = http.expectOne('/api/shaders/waves/history');
    expect(request.request.method).toBe('GET');
    request.flush({ history: [ENTRY] });
    await expect(listed).resolves.toEqual([ENTRY]);
  });

  it('names and clears a checkpoint', async () => {
    const named = api.setCheckpoint('waves', 3, 'Before bloom');
    const put = http.expectOne('/api/shaders/waves/history/3/checkpoint');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ name: 'Before bloom' });
    put.flush({ entry: { ...ENTRY, checkpointName: 'Before bloom' } });
    await expect(named).resolves.toMatchObject({ checkpointName: 'Before bloom' });

    const cleared = api.setCheckpoint('waves', 3, null);
    const clear = http.expectOne('/api/shaders/waves/history/3/checkpoint');
    expect(clear.request.body).toEqual({ name: null });
    clear.flush({ entry: ENTRY });
    await expect(cleared).resolves.toEqual(ENTRY);
  });

  it('restores with the expected head and returns the new record', async () => {
    const restored = api.restoreHistory('waves', 3, 4);
    const post = http.expectOne('/api/shaders/waves/history/3/restore');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ expectedRevision: 4 });
    post.flush({ shader: RECORD });
    await expect(restored).resolves.toEqual(RECORD);
  });

  it('surfaces a stale head as a 409 ApiError', async () => {
    const restored = api.restoreHistory('waves', 3, 2);
    http
      .expectOne('/api/shaders/waves/history/3/restore')
      .flush(
        { error: { code: 'conflict', message: 'Shader "waves" was modified by another write' } },
        { status: 409, statusText: 'Conflict' },
      );
    const error = await restored.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
  });
});

describe('DesktopShaderApi history', () => {
  const shader = {
    listHistory: vi.fn(async () => [ENTRY]),
    setCheckpoint: vi.fn(async () => ENTRY),
    restoreHistory: vi.fn(async () => RECORD),
  };
  let api: DesktopShaderApi;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('electron', { bridge: { shader } });
    api = new DesktopShaderApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the generated bridge with the same arguments', async () => {
    await expect(api.listHistory('waves')).resolves.toEqual([ENTRY]);
    expect(shader.listHistory).toHaveBeenCalledWith('waves');

    await api.setCheckpoint('waves', 3, null);
    expect(shader.setCheckpoint).toHaveBeenCalledWith('waves', 3, null);

    await expect(api.restoreHistory('waves', 3, 4)).resolves.toEqual(RECORD);
    expect(shader.restoreHistory).toHaveBeenCalledWith('waves', 3, 4);
  });

  it('wraps an IPC failure as an ApiError with the remote message', async () => {
    shader.restoreHistory.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'shader:restore-history': StorageError: Invalid expected revision",
      ),
    );
    const error = await api.restoreHistory('waves', 3, 0).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('StorageError: Invalid expected revision');
  });
});
