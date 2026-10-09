const HOUR = 3_600_000;
/** For a sub-hour operation containing no hourly sample, use its two enclosing
 * forecast hours conservatively. Never extrapolate a missing endpoint or fill zero. */
export function forecastSampleWindow(start:number,end:number):[number,number] {
 return Math.ceil(start/HOUR)*HOUR>end?[Math.floor(start/HOUR)*HOUR,Math.ceil(end/HOUR)*HOUR]:[start,end];
}
