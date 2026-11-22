// Entry of pad.html: the tablet page (tracing) or the phone page, by screen size
// (or the user's choice, see device.ts).
import '../legacy';
import { deviceKind } from './device';

if (deviceKind() === 'phone') void import('./phone');
else void import('./main');
