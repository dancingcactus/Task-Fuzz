/* Full animated Fuzz (generated from the Fuzz Triage prototype). */
window.FUZZ_SVG = `        <svg id="bot" viewBox="0 0 140 126" data-mood="idle" data-arm="none" data-urgency="0" role="img" aria-label="Fuzz, a small robot with an old TV for a head and two antennas of different lengths">
          <defs>
            <clipPath id="scr"><rect x="26" y="48" width="74" height="58" rx="17"/></clipPath>
            <radialGradient id="glowg" cx="50%" cy="45%" r="65%"><stop offset="0" stop-color="#FFC65C" stop-opacity=".2"/><stop offset="1" stop-color="#FFC65C" stop-opacity="0"/></radialGradient>
            <pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".3"/></pattern>
            <filter id="noise" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="1" seed="4"/><feColorMatrix type="saturate" values="0"/></filter>
          </defs>
          <ellipse cx="70" cy="119" rx="46" ry="4.5" fill="#000" opacity=".12"/>
          <g class="body-wrap">
            <!-- antennas: long (left) and short (right), one shared pivot -->
            <g class="ant ant-l">
              <path class="stalk" d="M70 42Q58 24 35 6"/>
              <circle class="tip" cx="35" cy="5.5" r="4.4"/>
              <path class="hit" d="M70 42Q58 24 35 6"/>
            </g>
            <g class="ant ant-r">
              <path class="stalk" d="M70 42Q77 34 90 25"/>
              <rect class="tip" x="86.5" y="21" width="7" height="7" rx="1.5" transform="rotate(45 90 24.5)"/>
              <path class="hit" d="M70 42Q77 34 90 25"/>
            </g>
            <g class="speed"><path d="M2 62h13M0 78h15M3 94h12"/></g>
            <!-- TV head -->
            <rect x="16" y="42" width="108" height="72" rx="14" fill="var(--cab)"/>
            <path d="M16 102H124Q124 114 110 114H30Q16 114 16 102Z" fill="var(--cab-d)" opacity=".5"/>
            <rect x="16.8" y="42.8" width="106.4" height="70.4" rx="13.4" fill="none" stroke="var(--trim)" stroke-opacity=".4" stroke-width="1.5"/>
            <rect x="60" y="37.5" width="20" height="8" rx="4" fill="var(--bezel)"/><circle cx="70" cy="41.5" r="2.4" fill="var(--trim)" opacity=".75"/>
            <rect x="22" y="44" width="82" height="66" rx="21" fill="var(--bezel)"/>
            <!-- knobs and speaker -->
            <g class="knob knob-a"><circle cx="114" cy="59" r="5.4" fill="var(--trim)"/><path d="M114 54.5V59" stroke="var(--bezel)" stroke-width="1.8" stroke-linecap="round"/></g>
            <g class="knob knob-b"><circle cx="114" cy="76" r="5.4" fill="var(--trim)"/><path d="M114 71.5V76" stroke="var(--bezel)" stroke-width="1.8" stroke-linecap="round"/></g>
            <circle class="ledhalo" cx="114" cy="87" r="4.6"/><circle class="led" cx="114" cy="87" r="2.3"/>
            <g stroke="var(--bezel)" stroke-width="2" stroke-linecap="round" opacity=".7"><path d="M108 95H120"/><path d="M108 100H120"/><path d="M108 105H120"/></g>
            <!-- screen -->
            <g clip-path="url(#scr)">
              <rect x="26" y="48" width="74" height="58" fill="var(--screen)"/>
              <rect x="26" y="48" width="74" height="58" fill="url(#glowg)"/>
              <g class="ch ch1"><rect x="26" y="48" width="74" height="58" fill="#3a3632"/><circle cx="63" cy="75" r="21" fill="none" stroke="#e8e0d0" stroke-width="2"/><path d="M63 48V106M26 75H100" stroke="#e8e0d0" stroke-width="1.4"/><rect x="26" y="94" width="14.8" height="12" fill="#f2efe6"/><rect x="40.8" y="94" width="14.8" height="12" fill="#bdb8ac"/><rect x="55.6" y="94" width="14.8" height="12" fill="#85807a"/><rect x="70.4" y="94" width="14.8" height="12" fill="#524e49"/><rect x="85.2" y="94" width="14.8" height="12" fill="#25221f"/></g>
              <g class="ch ch2"><rect x="26" y="48" width="10.6" height="48" fill="#d9d9d9"/><rect x="36.6" y="48" width="10.6" height="48" fill="#d9d94a"/><rect x="47.1" y="48" width="10.6" height="48" fill="#4ad9d9"/><rect x="57.7" y="48" width="10.6" height="48" fill="#4ad94a"/><rect x="68.3" y="48" width="10.6" height="48" fill="#d94ad9"/><rect x="78.9" y="48" width="10.6" height="48" fill="#d94a4a"/><rect x="89.4" y="48" width="10.6" height="48" fill="#4a4ad9"/><rect x="26" y="96" width="74" height="10" fill="#1a1a1a"/></g>
              <g class="ch ch3"><rect x="26" y="48" width="74" height="58" fill="#F6C77A"/><circle cx="79" cy="66" r="9" fill="#E8894A"/><path d="M26 106V90Q44 74 62 90T100 86V106Z" fill="#A5603A"/><path d="M26 106V98Q50 88 70 99T100 96V106Z" fill="#6E3F27"/></g>
              <g class="ch ch4"><rect x="26" y="48" width="74" height="58" fill="#1d1a2b"/><g class="bgy"><g class="bgx"><rect class="logo" x="27" y="49" width="14" height="8" rx="2"/></g></g></g>
              <g class="ch ch5"><rect x="26" y="48" width="74" height="58" fill="#14231b"/><path d="M26 62H100M26 77H100M26 92H100M44 48V106M63 48V106M82 48V106" stroke="#2d4a3a" stroke-width=".8" fill="none"/><path d="M30 98L40 90L48 94L58 80L68 86L78 66L88 72L96 58V106H30Z" fill="#7bd88f" opacity=".25"/><path d="M30 98L40 90L48 94L58 80L68 86L78 66L88 72L96 58" fill="none" stroke="#7bd88f" stroke-width="2" stroke-linejoin="round"/></g>
              <g class="face">
                <circle class="cheek" cx="34" cy="92" r="4.8" fill="#FF8A5C" opacity=".28"/><circle class="cheek" cx="93" cy="92" r="4.8" fill="#FF8A5C" opacity=".28"/>
                <g class="eyes" id="eyes">
                  <g class="eye"><rect x="43" y="63" width="11" height="17" rx="5.5"/><circle class="pupil" cx="48.5" cy="71.5" r="2.4"/></g>
                  <g class="eye"><rect x="73" y="63" width="11" height="17" rx="5.5"/><circle class="pupil" cx="78.5" cy="71.5" r="2.4"/></g>
                </g>
                <g class="eyes-happy"><path d="M42.5 76Q48.5 66 54.5 76"/><path d="M72.5 76Q78.5 66 84.5 76"/></g>
                <g class="eyes-heart"><path transform="translate(63.5 55.2) scale(.52) translate(-48.5 -71.7)" d="M48.5 80C42 75.5 40 71.5 40 68.5C40 65.5 42.3 63.5 44.8 63.5C46.5 63.5 47.8 64.5 48.5 66C49.2 64.5 50.5 63.5 52.2 63.5C54.7 63.5 57 65.5 57 68.5C57 71.5 55 75.5 48.5 80Z"/></g>
                <g class="eyes-star" fill="var(--glow)"><path d="M48.5 62l3 6.2 6.8.9-5 4.7 1.3 6.7-6.1-3.3-6.1 3.3 1.3-6.7-5-4.7 6.8-.9z"/><g transform="translate(30 0)"><path d="M48.5 62l3 6.2 6.8.9-5 4.7 1.3 6.7-6.1-3.3-6.1 3.3 1.3-6.7-5-4.7 6.8-.9z"/></g></g>
                <g class="brows"><path d="M40 60L55 54"/><path d="M72 54L87 60"/></g>
                <g class="brow-q" fill="none" stroke="var(--glow)" stroke-width="3" stroke-linecap="round"><path d="M41 60Q48 58.5 55 61"/><path d="M71 52Q79 46 87 52"/></g>
                <text class="osd" id="osd" x="63" y="57" text-anchor="middle" font-size="8"></text>
                <path class="m m-smile" d="M55 90Q63.5 98 72 90"/>
                <path class="m m-grin" d="M54 89Q63.5 104 73 89Z"/>
                <path class="m m-flat" d="M57 94H70"/>
                <path class="m m-pout" d="M57 94.5Q64 93 71 96.5"/>
                <path class="m m-wobble" d="M54 95Q58 90 62 95T70 95 74 94"/>
                <ellipse class="m m-o" cx="63.5" cy="94" rx="4.5" ry="5.5"/>
                <g class="m m-grit"><rect x="55" y="88" width="17" height="9" rx="3" fill="none" stroke="#FFC65C" stroke-width="2.6"/><path d="M60.5 88V97M66 88V97" stroke="#FFC65C" stroke-width="1.6" fill="none"/></g>
                <g class="shades"><rect x="37" y="61" width="23" height="20" rx="8" fill="#0a0a0c" stroke="var(--glow)" stroke-width="2"/><rect x="67" y="61" width="23" height="20" rx="8" fill="#0a0a0c" stroke="var(--glow)" stroke-width="2"/><rect x="58" y="64.5" width="9" height="3.5" fill="var(--glow)"/><rect x="41" y="64" width="10" height="3" rx="1.5" fill="#fff" opacity=".55"/><rect x="71" y="64" width="10" height="3" rx="1.5" fill="#fff" opacity=".55"/></g>
                <path class="sweat" d="M91 54Q96 62 91 66Q86 62 91 54Z" fill="#8FC4E8"/>
                <g class="sparkle" fill="#fff"><path d="M90 52l2.6 6 6 2.6-6 2.6-2.6 6-2.6-6-6-2.6 6-2.6z"/></g>
              </g>
              <g class="crtoff"><rect x="26" y="48" width="74" height="58"/></g>
              <rect class="static" x="22" y="44" width="86" height="70" fill="#fff" opacity=".24" filter="url(#noise)"/>
              <rect class="roll" x="22" y="48" width="86" height="12" fill="#fff" opacity=".1"/>
              <g class="bars" opacity=".9">
                <rect x="26" y="48" width="10.6" height="58" fill="#d9d9d9"/><rect x="36.6" y="48" width="10.6" height="58" fill="#d9d94a"/><rect x="47.1" y="48" width="10.6" height="58" fill="#4ad9d9"/><rect x="57.7" y="48" width="10.6" height="58" fill="#4ad94a"/><rect x="68.3" y="48" width="10.6" height="58" fill="#d94ad9"/><rect x="78.9" y="48" width="10.6" height="58" fill="#d94a4a"/><rect x="89.4" y="48" width="10.6" height="58" fill="#4a4ad9"/>
              </g>
              <g class="sch sch-moon"><rect x="26" y="48" width="74" height="58" fill="#1c2040"/><circle cx="56" cy="72" r="14" fill="#F6E3C8"/><circle cx="64" cy="67" r="12" fill="#1c2040"/><circle class="twk" cx="82" cy="60" r="1.6" fill="#F6E3C8"/><circle class="twk" style="animation-delay:.4s" cx="90" cy="76" r="1.3" fill="#F6E3C8"/><circle class="twk" style="animation-delay:.8s" cx="40" cy="58" r="1.2" fill="#F6E3C8"/><circle class="twk" style="animation-delay:.2s" cx="78" cy="86" r="1.5" fill="#F6E3C8"/></g>
              <g class="sch sch-sun"><rect x="26" y="48" width="74" height="58" fill="#F9D58E"/><path class="rays" d="M82.0 86.0L89.0 86.0M76.4 99.4L81.4 104.4M63.0 105.0L63.0 112.0M49.6 99.4L44.6 104.4M44.0 86.0L37.0 86.0M49.6 72.6L44.6 67.6M63.0 67.0L63.0 60.0M76.4 72.6L81.4 67.6" stroke="#FFF3CF" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="63" cy="86" r="14" fill="#E8894A"/><rect x="26" y="88" width="74" height="18" fill="#A5603A"/></g>
              <g class="sch sch-cal"><rect x="26" y="48" width="74" height="58" fill="#E9DCC6"/><rect x="36" y="54" width="54" height="38" rx="4" fill="#FFF8EC"/><path d="M36 58a4 4 0 0 1 4-4h46a4 4 0 0 1 4 4v7H36z" fill="#C9663C"/><circle cx="46" cy="54" r="1.8" fill="#3B2B23"/><circle cx="80" cy="54" r="1.8" fill="#3B2B23"/><g fill="#d8c9ad"><rect x="40" y="69" width="6" height="5" rx="1"/><rect x="49.5" y="69" width="6" height="5" rx="1"/><rect x="59" y="69" width="6" height="5" rx="1"/><rect x="68.5" y="69" width="6" height="5" rx="1"/><rect x="78" y="69" width="6" height="5" rx="1"/><rect x="40" y="77" width="6" height="5" rx="1"/><rect x="49.5" y="77" width="6" height="5" rx="1"/><rect x="68.5" y="77" width="6" height="5" rx="1"/><rect x="78" y="77" width="6" height="5" rx="1"/><rect x="40" y="85" width="6" height="5" rx="1"/><rect x="49.5" y="85" width="6" height="5" rx="1"/></g><rect x="59" y="76" width="7" height="7" rx="1.5" fill="#F2AE43"/><path d="M60.5 79.6l2 2 3-3.8" fill="none" stroke="#3B2B23" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>
              <g class="sch sch-check"><rect x="26" y="48" width="74" height="58" fill="#17301f"/><path class="tick" d="M46 79L58 91L82 63" fill="none" stroke="#7bd88f" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></g>
              <g class="schlabel"><rect x="36" y="93" width="54" height="10" rx="5" fill="#000" opacity=".6"/><text id="schosd" x="63" y="100.3" text-anchor="middle" font-size="6.5">TONIGHT 6PM</text></g>
              <rect class="envy" x="26" y="48" width="74" height="58" fill="#5FD08A"/>
              <text class="chosd" id="chosd" x="97" y="58" text-anchor="end" font-size="8">CH 03</text>
              <rect x="26" y="48" width="74" height="58" fill="url(#scan)" pointer-events="none"/>
              <path d="M34 60Q38 53 52 52" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".22"/>
              <rect class="scrflash" x="26" y="48" width="74" height="58" fill="#fff"/>
            </g>
          </g>
          <g class="zzz"><text x="104" y="40" font-size="14">z</text><text x="104" y="40" font-size="18">z</text><text x="104" y="40" font-size="22">Z</text></g>
        </svg>`;
