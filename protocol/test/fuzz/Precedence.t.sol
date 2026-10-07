// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PrecedenceHarness} from "../utils/PrecedenceHarness.sol";

/// @notice Error precedence over arbitrary combinations: any subset of the documented checks failing at once, on
///         any settlement path, reports the first one in the IPayLinkV2 order. Complements the deterministic pair
///         matrix in unit/Precedence.t.sol.
contract PrecedenceFuzzTest is PrecedenceHarness {
    /// @dev The reported check (`firstSeed`, or none) is drawn uniformly and any subset of the later checks fails with
    ///      it. A plain random bitmask would almost always contain `InvalidInvoice` and rarely reach the later checks.
    function testFuzz_FirstFailingCheckIsReported(uint8 pathSeed, uint8 firstSeed, uint16 laterBits, uint256 variant)
        public
    {
        uint8 first = firstSeed % (N_CHECKS + 1);
        uint16 mask = first == N_CHECKS ? 0 : uint16((uint256(laterBits) << (first + 1)) | (uint256(1) << first));
        _run(_build(Path(pathSeed % 4), mask, variant));
    }
}
