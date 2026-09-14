# Vendored libraries

`jspdf` and `jspdf-autotable`, copied from `node_modules` and served from this
origin rather than a CDN.

They were loaded from cdnjs until a pinned URL started returning 404 and the
Download PDF button failed with "PDF library didn't load" — an outage in someone
else's service breaking a sales call. Serving them ourselves removes that, works
offline, and means no third party sees who is generating quotations.

Refresh after upgrading either package:

    npm run vendor
