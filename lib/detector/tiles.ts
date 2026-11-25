export type Tile = { index: number; x: number; y: number; w: number; h: number };

/**
 * Divide una imagen en una grilla de mosaicos de ~tileSize px con `overlap` px de solape.
 * El solape tiene que ser mayor que el rótulo más largo esperable, así cualquier texto
 * entra entero en al menos un mosaico aunque otro lo corte por el borde.
 */
export function planTiles(width: number, height: number, tileSize: number, overlap: number, extraPerAxis = 0): Tile[] {
  const axis = (len: number) => {
    if (len <= tileSize && !extraPerAxis) return [{ start: 0, size: len }];
    const step = tileSize - overlap;
    // `extraPerAxis` agrega mosaicos por eje: la grilla queda "corrida", con las uniones en otro lugar.
    const count = Math.max(1, Math.ceil((len - overlap) / step)) + extraPerAxis;
    // Repartimos el sobrante para que todos los mosaicos midan lo mismo.
    const size = Math.ceil((len + overlap * (count - 1)) / count);
    const realStep = (len - size) / (count - 1);
    return Array.from({ length: count }, (_, i) => ({ start: Math.round(i * realStep), size }));
  };
  const xs = axis(width);
  const ys = axis(height);
  const tiles: Tile[] = [];
  for (const yy of ys) {
    for (const xx of xs) {
      tiles.push({
        index: tiles.length,
        x: xx.start,
        y: yy.start,
        w: Math.min(xx.size, width - xx.start),
        h: Math.min(yy.size, height - yy.start),
      });
    }
  }
  return tiles;
}

/**
 * ¿La caja (px de imagen) toca un borde del mosaico que no es borde de la imagen?
 * Si es así, el texto puede estar cortado y otro mosaico lo ve entero.
 */
export function touchesInnerEdge(
  box: { x: number; y: number; w: number; h: number },
  tile: Tile,
  image: { width: number; height: number },
  margin: number,
): boolean {
  const left = tile.x > 0 && box.x - tile.x < margin;
  const top = tile.y > 0 && box.y - tile.y < margin;
  const right = tile.x + tile.w < image.width && tile.x + tile.w - (box.x + box.w) < margin;
  const bottom = tile.y + tile.h < image.height && tile.y + tile.h - (box.y + box.h) < margin;
  return left || top || right || bottom;
}
