// Feature modules plug into the game here. Each may export:
//   init(app, isNew)       — register systems, panels, toolbar categories, event handlers
//   frame(app, dt, now)    — per-frame visual updates
import { cityFeature } from './features/cityFeature.js';
import { servicesFeature } from './features/servicesFeature.js';
import { economyPanels } from './features/economyPanels.js';
import { transportFeature } from './features/transportFeature.js';
import { climateFeature } from './features/climateFeature.js';
import { infoViewsFeature } from './features/infoViews.js';
import { governanceFeature } from './features/governanceFeature.js';
import { progressionFeature } from './features/progressionFeature.js';
import { signatureFeature } from './features/signatureFeature.js';
import { achievementsFeature } from './features/achievementsFeature.js';
import { metaFeature } from './features/metaFeature.js';
import { editorsFeature } from './features/editorsFeature.js';
import { accountFeature } from './features/accountFeature.js';
import { notificationsFeature } from './features/notificationsFeature.js';
import { layersFeature } from './features/layersFeature.js';
import './features/powerPanel.js';
import './features/happinessPanel.js';

export const features = [
  progressionFeature, editorsFeature, climateFeature, servicesFeature, cityFeature, transportFeature,
  governanceFeature, signatureFeature, infoViewsFeature, economyPanels, metaFeature, achievementsFeature, accountFeature,
  notificationsFeature, layersFeature,
];
