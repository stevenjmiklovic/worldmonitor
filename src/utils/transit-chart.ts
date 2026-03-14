import { createChart, LineSeries, type IChartApi } from 'lightweight-charts';
import { getCSSColor } from '@/utils';

interface TransitPoint {
  date: string;
  tanker: number;
  cargo: number;
}

export class TransitChart {
  private chart: IChartApi | null = null;
  private themeHandler: (() => void) | null = null;
  mount(container: HTMLElement, history: TransitPoint[]): void {
    this.destroy();
    if (!history.length) return;
    container.style.minHeight = '120px';

    const textColor = getCSSColor('--text-dim') || '#888';
    const gridColor = getCSSColor('--border-subtle') || '#333';
    const tankerColor = getCSSColor('--accent-primary') || '#4fc3f7';
    const cargoColor = '#ff9800';

    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor },
      grid: { vertLines: { visible: false }, horzLines: { color: gridColor } },
      crosshair: { mode: 0 },
      timeScale: { timeVisible: false, borderVisible: false },
      rightPriceScale: { borderVisible: false },
    });

    const tankerSeries = this.chart.addSeries(LineSeries, {
      color: tankerColor, lineWidth: 2, title: 'Tanker',
      crosshairMarkerRadius: 3,
    });
    const cargoSeries = this.chart.addSeries(LineSeries, {
      color: cargoColor, lineWidth: 2, title: 'Cargo',
      crosshairMarkerRadius: 3,
    });

    tankerSeries.setData(history.map(d => ({ time: d.date, value: d.tanker })));
    cargoSeries.setData(history.map(d => ({ time: d.date, value: d.cargo })));
    this.chart.timeScale().fitContent();

    this.themeHandler = () => {
      if (!this.chart) return;
      this.chart.applyOptions({
        layout: { textColor: getCSSColor('--text-dim') || '#888' },
        grid: { horzLines: { color: getCSSColor('--border-subtle') || '#333' } },
      });
    };
    window.addEventListener('theme-changed', this.themeHandler);
  }

  destroy(): void {
    if (this.themeHandler) {
      window.removeEventListener('theme-changed', this.themeHandler);
      this.themeHandler = null;
    }
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
  }
}
