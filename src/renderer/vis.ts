import type { BackendEvent } from '../shared/backend.js';
import type { VisId } from '../shared/prefs.js';
import './host.js';
import { createVisualizer } from './visualizers.js';

// A visualizer in its own window ("Show Visualizations in Separate
// Windows"). The location hash is the visualizer id; the main process sends
// vis frames here instead of to the main window.

const vis = createVisualizer(location.hash.slice(1) as VisId);
vis.canvas.className = 'vis';
document.body.append(vis.canvas);

new ResizeObserver(() => vis.redraw()).observe(vis.canvas);

window.audHost.onEvent((e) => {
  const event = e as BackendEvent;
  if (event.type === 'vis') vis.render(event);
  else if (event.type === 'vis-clear') vis.clear();
});
