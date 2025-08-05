export function createNumberTranslator(getStartFn: () => bigint): (num: bigint) => string {
    return (theNumber: bigint) => {
        const originalStart = getStartFn();
        theNumber += originalStart;
        const zeroPad = (num: bigint) => String(num).padStart(3, '0');
        const seconds = theNumber / BigInt(1_000_000_000);
        const millis = zeroPad((theNumber / BigInt(1_000_000)) % BigInt(1000));
        const micros = zeroPad((theNumber / BigInt(1_000)) % BigInt(1000));
        const nanos = zeroPad(theNumber % BigInt(1000));
        return seconds + '.' + millis + ' ' + micros + ' ' + nanos;
    };
}
