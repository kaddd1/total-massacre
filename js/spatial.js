// Uniform spatial hash grid, rebuilt every tick (linked lists in typed arrays).
(function (TM) {
  'use strict';

  class SpatialGrid {
    constructor(w, h, cell) {
      this.cell = cell;
      this.inv = 1 / cell;
      this.cols = Math.ceil(w / cell) + 1;
      this.rows = Math.ceil(h / cell) + 1;
      this.head = new Int32Array(this.cols * this.rows);
      this.cap = 1024;
      this.next = new Int32Array(this.cap);
      this.items = new Array(this.cap);
      this.count = 0;
    }

    clear() {
      this.head.fill(-1);
      this.count = 0;
    }

    _cellX(x) {
      const c = (x * this.inv) | 0;
      return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    }
    _cellY(y) {
      const c = (y * this.inv) | 0;
      return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
    }

    insert(obj) {
      if (this.count >= this.cap) {
        this.cap *= 2;
        const n = new Int32Array(this.cap);
        n.set(this.next);
        this.next = n;
        this.items.length = this.cap;
      }
      const i = this.count++;
      this.items[i] = obj;
      const c = this._cellY(obj.y) * this.cols + this._cellX(obj.x);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }

    // Collects objects whose cell overlaps the circle into `out`. Returns count.
    // Caller does the precise distance test.
    query(x, y, r, out) {
      const x0 = this._cellX(x - r), x1 = this._cellX(x + r);
      const y0 = this._cellY(y - r), y1 = this._cellY(y + r);
      let n = 0;
      const head = this.head, next = this.next, items = this.items, cols = this.cols;
      for (let cy = y0; cy <= y1; cy++) {
        const row = cy * cols;
        for (let cx = x0; cx <= x1; cx++) {
          let i = head[row + cx];
          while (i !== -1) {
            out[n++] = items[i];
            i = next[i];
          }
        }
      }
      return n;
    }
  }

  TM.SpatialGrid = SpatialGrid;
})(window.TM = window.TM || {});
