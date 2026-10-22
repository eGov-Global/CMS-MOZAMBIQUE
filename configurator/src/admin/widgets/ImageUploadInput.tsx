import { useEffect, useRef, useState } from 'react';
import { useInput, type InputProps } from 'ra-core';
import { Upload, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { digitClient } from '@/providers/bridge';
import { useApp } from '../../App';
import { ratioLabel, shapeError } from './imageShape';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

interface ImageUploadInputProps extends InputProps {
  label?: string;
  help?: string;
  /** Required width ÷ height, e.g. 4 for a 4:1 strip. */
  aspectRatio: number;
  /** Allowed deviation from aspectRatio, as a fraction (0.02 = ±2%). */
  aspectTolerance?: number;
  minWidth?: number;
  minHeight?: number;
  /** Shown while no image has been uploaded: what the app renders instead. */
  defaultPreview?: string;
  /** Filestore module the upload is filed under. */
  module?: string;
}

const readDimensions = (file: File): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      reject(new Error('The file could not be read as an image.'));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

/** Uploads an image to filestore and stores its fileStoreId. Images of the
 *  wrong shape are refused before upload: the app draws them at a fixed
 *  height, so anything but the required ratio would be squashed or cropped. */
export function ImageUploadInput({
  label,
  help,
  aspectRatio,
  aspectTolerance = 0.02,
  minWidth = 0,
  minHeight = 0,
  defaultPreview,
  module = 'branding',
  ...inputProps
}: ImageUploadInputProps) {
  const { id, field } = useInput(inputProps);
  const { state } = useApp();
  const tenantId = state.tenant;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{ id: string; url: string | null } | null>(null);
  const fileStoreId: string | undefined = field.value || undefined;

  useEffect(() => {
    if (!fileStoreId) return;
    let cancelled = false;
    digitClient
      .filestoreGetUrl(tenantId, [fileStoreId])
      .then((rows: Record<string, unknown>[]) => {
        const url = (rows[0] as { url?: string } | undefined)?.url;
        if (!cancelled) setResolved({ id: fileStoreId, url: typeof url === 'string' ? url.split(',')[0] : null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`Could not load the uploaded image: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [fileStoreId, tenantId]);

  const reject = (message: string) => {
    setError(message);
    toast({ title: 'Image not accepted', description: message, variant: 'destructive' });
  };

  const onFile = async (file: File) => {
    setError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) {
      reject('Use a PNG or JPG image.');
      return;
    }
    setBusy(true);
    try {
      const { width, height } = await readDimensions(file);
      const refused = shapeError(width, height, { aspectRatio, aspectTolerance, minWidth, minHeight });
      if (refused) {
        reject(refused);
        return;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      const newId = await digitClient.filestoreUpload(tenantId, module, file.name, buf, file.type);
      if (!newId) throw new Error('Filestore returned no file id.');
      field.onChange(newId);
      toast({ title: 'Image uploaded', description: `${file.name} — save to apply it.` });
    } catch (e) {
      reject(`Upload failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // A URL resolved for an earlier id must not show once the id has changed.
  const previewUrl = resolved && resolved.id === fileStoreId ? resolved.url : null;
  const shown = previewUrl ?? (fileStoreId ? null : defaultPreview);

  return (
    <div className="space-y-1.5">
      {label && (
        <Label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </Label>
      )}
      <div className="rounded-md border border-border p-3 space-y-3">
        {/* The preview box has the required shape, so the operator sees the
            ratio the app expects before choosing a file. The dark fill matches
            the sidebar the logo sits on. */}
        <div
          className="w-full max-w-[320px] rounded bg-slate-800 flex items-center justify-center overflow-hidden"
          style={{ aspectRatio: String(aspectRatio) }}
        >
          {shown ? (
            <img src={shown} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs text-slate-300">Loading preview…</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {fileStoreId ? 'Uploaded image' : 'Default image (eGov logo)'} · required shape {ratioLabel(aspectRatio)}
          {minWidth ? `, at least ${minWidth} × ${minHeight} px` : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            id={id}
            ref={fileRef}
            type="file"
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) onFile(file);
            }}
          />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload />
            {busy ? 'Uploading…' : fileStoreId ? 'Replace image' : 'Upload image'}
          </Button>
          {fileStoreId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                field.onChange(undefined);
              }}
            >
              <RotateCcw />
              Use default
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
