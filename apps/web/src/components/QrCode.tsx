import { useEffect, useState, type ReactElement } from 'react';
import QRCode from 'qrcode';
import { Skeleton } from '@neo/ui';

/** Renders `value` as a QR code image (generated locally; nothing leaves the device). */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111118', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (!src) return <Skeleton width={size} height={size} style={{ borderRadius: 12 }} />;
  return <img src={src} width={size} height={size} alt={label} style={{ display: 'block', borderRadius: 12, border: '1px solid var(--neo-border)', background: '#fff', padding: 8 }} />;
}
