// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded "><a href="intro.html"><strong aria-hidden="true">1.</strong> Intro</a></li><li class="chapter-item expanded "><a href="ractors_what_and_why.html"><strong aria-hidden="true">2.</strong> Ractors, what and why</a></li><li class="chapter-item expanded "><a href="ruby_heap.html"><strong aria-hidden="true">3.</strong> Ruby heap</a></li><li class="chapter-item expanded "><a href="counter_the_wrong_way.html"><strong aria-hidden="true">4.</strong> Counter, the wrong way</a></li><li class="chapter-item expanded "><a href="atomics.html"><strong aria-hidden="true">5.</strong> Atomics</a></li><li class="chapter-item expanded "><a href="counter_the_right_way.html"><strong aria-hidden="true">6.</strong> Counter, the right way</a></li><li class="chapter-item expanded "><a href="containers_ractors_and_gc.html"><strong aria-hidden="true">7.</strong> Containers, Ractors, and GC</a></li><li class="chapter-item expanded "><a href="concurrent_hash_map.html"><strong aria-hidden="true">8.</strong> Concurrent HashMap</a></li><li class="chapter-item expanded "><a href="concurrent_object_pool.html"><strong aria-hidden="true">9.</strong> Concurrent ObjectPool</a></li><li class="chapter-item expanded "><a href="naive_concurrent_queue.html"><strong aria-hidden="true">10.</strong> (Naive) Concurrent Queue</a></li><li class="chapter-item expanded "><a href="parallel_test_framework.html"><strong aria-hidden="true">11.</strong> Parallel Test Framework</a></li><li class="chapter-item expanded "><a href="better_queue/intro.html"><strong aria-hidden="true">12.</strong> A Better Queue</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="better_queue/lock_free_mpmc_queue.html"><strong aria-hidden="true">12.1.</strong> Lock Free MPMC Queue</a></li><li class="chapter-item expanded "><a href="better_queue/adding_blocking_interface.html"><strong aria-hidden="true">12.2.</strong> Adding Blocking Interface</a></li><li class="chapter-item expanded "><a href="better_queue/marking.html"><strong aria-hidden="true">12.3.</strong> Marking</a></li><li class="chapter-item expanded "><a href="better_queue/writing_a_web_server.html"><strong aria-hidden="true">12.4.</strong> Writing a Web Server</a></li></ol></li><li class="chapter-item expanded "><a href="conclusion.html"><strong aria-hidden="true">13.</strong> Conclusion</a></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
