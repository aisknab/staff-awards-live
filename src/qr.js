import QRCode from 'qrcode';

export async function createQrSvg(value) {
  return QRCode.toString(value, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 3,
    width: 512,
    color: { dark: '#101114', light: '#ffffff' },
  });
}
